import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ORDER_ID, PARCEL_ID, SHIRT_ID, adminOrder, shipment, toast } from "@/test/fixtures/orders";
import { renderWithMe, staff } from "@/test/render";
import { fail, on, server } from "@/test/server";

import { packingSlipUrl } from "./fulfil-dialog";
import { Shipments } from "./shipments";

vi.mock("sonner", async () => (await import("@/test/fixtures/orders")).sonnerMock);

const PARCEL = "/api/v1/admin/fulfilments/{fulfilment_id}" as const;

function renderShipments(parcels = [shipment()], me = staff()) {
  const onUpdated = vi.fn();
  renderWithMe(<Shipments order={adminOrder({ shipments: parcels })} onUpdated={onUpdated} />, {
    me,
  });
  return { onUpdated, user: userEvent.setup() };
}

function parcel(index: number) {
  const item = screen.getAllByRole("listitem").filter((li) => /^Parcel/.test(li.textContent ?? ""))[
    index
  ];
  if (!item) throw new Error(`no parcel ${String(index)}`);
  return item;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Shipments", () => {
  it("says when nothing has shipped", () => {
    renderShipments([]);
    expect(screen.getByText("Nothing has shipped yet.")).toBeInTheDocument();
  });

  it("lists each parcel with its carrier, tracking, contents and paperwork", () => {
    renderShipments([
      shipment(),
      shipment({
        id: "p2",
        carrier: null,
        tracking_number: null,
        tracking_url: null,
        status: "delivered",
        delivered_at: "2026-09-04T12:00:00Z",
        lines: [
          { order_item_id: SHIRT_ID, quantity: 2 },
          { order_item_id: "gone", quantity: 1 },
        ],
      }),
    ]);
    const first = parcel(0);
    expect(within(first).getByText("In transit")).toBeInTheDocument();
    expect(within(first).getByText("UPS")).toBeInTheDocument();
    expect(within(first).getByRole("link", { name: /1Z999/ })).toHaveAttribute(
      "href",
      "https://track.example/1Z999",
    );
    expect(within(first).getByText("1 × Canvas tote")).toBeInTheDocument();
    expect(within(first).getByRole("link", { name: "Packing slip" })).toHaveAttribute(
      "href",
      packingSlipUrl(ORDER_ID, PARCEL_ID),
    );
    expect(within(first).queryByText("Delivered")).not.toBeInTheDocument();

    const second = parcel(1);
    expect(within(second).getAllByText("—")).toHaveLength(2);
    expect(within(second).getAllByText("Delivered")).toHaveLength(2); // badge and date row
    expect(within(second).getByText(/2 × Linen shirt/)).toHaveTextContent("2 × Linen shirt · M");
    expect(within(second).getByText("1 × Item")).toBeInTheDocument();
  });

  it("links a tracking URL even without a number", () => {
    renderShipments([shipment({ tracking_number: null })]);
    expect(screen.getByRole("link", { name: /Track/ })).toHaveAttribute(
      "href",
      "https://track.example/1Z999",
    );
  });

  it("offers updates only to staff who can fulfil", () => {
    renderShipments([shipment()], staff({ permissions: ["admin:access", "orders:read"] }));
    expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
  });

  it("moves a parcel on and changes its tracking", async () => {
    let sent: unknown;
    server.use(
      on("patch", PARCEL, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(shipment({ status: "delivered" }));
      }),
    );
    const { user, onUpdated } = renderShipments();
    await user.click(screen.getByRole("button", { name: "Update" }));
    const dialog = screen.getByRole("dialog", { name: "Update parcel" });
    expect(dialog).toHaveTextContent("Currently in transit.");
    const status = within(dialog).getByLabelText("Status");
    expect(
      within(status)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Keep the current status", "Mark delivered", "Mark delivery failed"]);
    await user.selectOptions(status, "delivered");
    await user.selectOptions(within(dialog).getByLabelText("Carrier"), "fedex");
    await user.clear(within(dialog).getByLabelText("Tracking number"));
    await user.type(within(dialog).getByLabelText("Tracking number"), " FX-9 ");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onUpdated).toHaveBeenCalledWith(shipment({ status: "delivered" }));
    });
    expect(sent).toEqual({ status: "delivered", carrier: "fedex", tracking_number: "FX-9" });
    expect(toast.success).toHaveBeenCalledWith("Parcel updated", expect.anything());
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("closes without a request when nothing changed", async () => {
    const { user, onUpdated } = renderShipments();
    await user.click(screen.getByRole("button", { name: "Update" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(onUpdated).not.toHaveBeenCalled();
  });

  it("shows a tracking number the server refused", async () => {
    server.use(
      fail("patch", PARCEL, {
        status: 422,
        slug: "validation-error",
        title: "Invalid",
        detail: "Check the tracking number.",
        errors: [{ field: "tracking_number", code: "invalid", message: "Not a UPS number." }],
      }),
    );
    const { user, onUpdated } = renderShipments();
    await user.click(screen.getByRole("button", { name: "Update" }));
    await user.type(screen.getByLabelText("Tracking number"), "X");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Check the tracking number.");
    expect(screen.getByLabelText("Tracking number")).toHaveAccessibleDescription(
      expect.stringContaining("Not a UPS number."),
    );
    expect(onUpdated).not.toHaveBeenCalled();
  });

  it("falls back to the problem title", async () => {
    server.use(fail("patch", PARCEL, { status: 500, title: "Server error" }));
    const { user } = renderShipments();
    await user.click(screen.getByRole("button", { name: "Update" }));
    await user.selectOptions(screen.getByLabelText("Status"), "failed");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Server error");
  });

  it("keeps a final parcel's status, and an unlisted carrier selectable", async () => {
    const { user } = renderShipments([
      shipment({ status: "delivered", carrier: "Pigeon Post", tracking_number: null }),
    ]);
    await user.click(screen.getByRole("button", { name: "Update" }));
    const dialog = screen.getByRole("dialog", { name: "Update parcel" });
    expect(dialog).toHaveTextContent("Currently delivered.");
    expect(dialog).toHaveTextContent("This parcel’s status is final");
    expect(within(dialog).queryByLabelText("Status")).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText("Carrier")).toHaveValue("Pigeon Post");
    expect(within(dialog).getByLabelText("Tracking number")).toHaveValue("");

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("names a status it does not know as it is", async () => {
    const { user } = renderShipments([shipment({ status: "lost" })]);
    await user.click(screen.getByRole("button", { name: "Update" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Currently lost.");
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});
