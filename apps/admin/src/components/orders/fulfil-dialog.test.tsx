import type { Schema } from "@velo/api-client";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ORDER_ID,
  PARCEL_ID,
  SHIRT_ID,
  adminOrder,
  orderLine,
  shipment,
  toast,
  toteLine,
} from "@/test/fixtures/orders";
import { fail, on, server } from "@/test/server";

import { FulfilDialog, packingSlipUrl } from "./fulfil-dialog";

vi.mock("sonner", async () => (await import("@/test/fixtures/orders")).sonnerMock);

type Order = Schema<"AdminOrderView">;

const FULFIL = "/api/v1/admin/orders/{order_id}/fulfilments" as const;

function renderDialog(order: Order = adminOrder()) {
  const onOpenChange = vi.fn();
  const onFulfilled = vi.fn();
  render(<FulfilDialog order={order} open onOpenChange={onOpenChange} onFulfilled={onFulfilled} />);
  return { onOpenChange, onFulfilled, user: userEvent.setup() };
}

function capture(parcel: Schema<"ShipmentView">) {
  const sent: unknown[] = [];
  server.use(
    on("post", FULFIL, async ({ request }) => {
      sent.push(await request.json());
      return HttpResponse.json(parcel, { status: 201 });
    }),
  );
  return sent;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("packingSlipUrl", () => {
  it("points at the order's slip, or one parcel's", () => {
    expect(packingSlipUrl(ORDER_ID)).toBe(
      `http://localhost:8000/api/v1/admin/orders/${ORDER_ID}/packing-slip`,
    );
    expect(packingSlipUrl(ORDER_ID, "a b")).toBe(
      `http://localhost:8000/api/v1/admin/orders/${ORDER_ID}/packing-slip?fulfilment_id=a%20b`,
    );
  });
});

describe("FulfilDialog", () => {
  it("selects everything left to ship and creates the parcel", async () => {
    const sent = capture(shipment());
    const { user, onFulfilled, onOpenChange } = renderDialog();

    // The tote has shipped already, so only the shirt is offered.
    expect(screen.queryByText("Canvas tote")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Linen shirt/ })).toBeChecked();
    expect(screen.getByText(/3 left to ship/)).toBeInTheDocument();
    expect(screen.getByLabelText("Qty")).toHaveValue(3);
    expect(
      screen.getByRole("checkbox", { name: "Email the customer that this parcel is on its way" }),
    ).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Create parcel" }));
    const done = await screen.findByRole("dialog", { name: "Parcel created" });
    expect(done).toHaveTextContent("Tracking 1Z999.");
    expect(sent).toEqual([
      { lines: [{ order_item_id: SHIRT_ID, quantity: 3 }], notify_customer: true },
    ]);
    expect(toast.success).toHaveBeenCalledWith(
      "Parcel created — the customer has been emailed",
      expect.anything(),
    );
    expect(onFulfilled).toHaveBeenCalledWith(shipment());
    expect(screen.getByRole("link", { name: "Print packing slip" })).toHaveAttribute(
      "href",
      packingSlipUrl(ORDER_ID, PARCEL_ID),
    );

    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("sends a part quantity, a carrier of the operator's own, tracking, and no email", async () => {
    const sent = capture(shipment({ tracking_number: null }));
    const { user } = renderDialog();

    await user.clear(screen.getByLabelText("Qty"));
    await user.type(screen.getByLabelText("Qty"), "2");
    expect(screen.queryByLabelText("Carrier name")).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Carrier"), "__other");
    await user.type(screen.getByLabelText("Carrier name"), " Pigeon Post ");
    await user.type(screen.getByLabelText(/Tracking number/), " PP-1 ");
    await user.click(
      screen.getByRole("checkbox", { name: "Email the customer that this parcel is on its way" }),
    );
    await user.click(screen.getByRole("button", { name: "Create parcel" }));

    expect(await screen.findByRole("dialog", { name: "Parcel created" })).toHaveTextContent(
      "No tracking number yet",
    );
    expect(sent).toEqual([
      {
        lines: [{ order_item_id: SHIRT_ID, quantity: 2 }],
        notify_customer: false,
        carrier: "Pigeon Post",
        tracking_number: "PP-1",
      },
    ]);
    expect(toast.success).toHaveBeenCalledWith("Parcel created", expect.anything());
  });

  it("sends a listed carrier by its code", async () => {
    const sent = capture(shipment());
    const { user } = renderDialog();
    await user.selectOptions(screen.getByLabelText("Carrier"), "dhl");
    await user.click(screen.getByRole("button", { name: "Create parcel" }));
    await screen.findByRole("dialog", { name: "Parcel created" });
    expect(sent[0]).toMatchObject({ carrier: "dhl" });
  });

  it("rejects a quantity it cannot ship, next to the line", async () => {
    const { user } = renderDialog();
    await user.clear(screen.getByLabelText("Qty"));
    await user.type(screen.getByLabelText("Qty"), "4");
    await user.click(screen.getByRole("button", { name: "Create parcel" }));
    expect(screen.getByLabelText("Qty")).toHaveAccessibleDescription("Enter 1 to 3.");
    expect(screen.getByLabelText("Qty")).toHaveAttribute("aria-invalid", "true");
  });

  it("needs at least one item", async () => {
    const { user } = renderDialog();
    await user.click(screen.getByRole("checkbox", { name: /Linen shirt/ }));
    expect(screen.getByLabelText("Qty")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Create parcel" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Choose at least one item to ship.");
  });

  it("shows the server's problem, and a line's own error beside it", async () => {
    server.use(
      fail("post", FULFIL, {
        status: 409,
        slug: "quantity-exceeded",
        title: "Too many",
        detail: "Some units were refunded meanwhile.",
        errors: [{ field: `lines.${SHIRT_ID}`, code: "too_many", message: "Only 1 left." }],
      }),
    );
    const { user, onFulfilled } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Create parcel" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Some units were refunded meanwhile.",
    );
    expect(screen.getByLabelText("Qty")).toHaveAccessibleDescription("Only 1 left.");
    expect(onFulfilled).not.toHaveBeenCalled();
  });

  it("falls back to the problem title", async () => {
    server.use(fail("post", FULFIL, { status: 500, title: "Server error" }));
    const { user } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Create parcel" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Server error");
  });

  it("has nothing to offer once everything has shipped", async () => {
    const { user, onOpenChange } = renderDialog(
      adminOrder({ lines: [orderLine({ quantity_fulfilled: 3 }), toteLine()] }),
    );
    expect(screen.getByText("Everything on this order has already shipped.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create parcel" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});
