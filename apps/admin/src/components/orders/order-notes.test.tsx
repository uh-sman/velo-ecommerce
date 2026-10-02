import type { Schema } from "@velo/api-client";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { adminOrder, toast } from "@/test/fixtures/orders";
import { renderWithMe, staff } from "@/test/render";
import { fail, on, server } from "@/test/server";

import { OrderNotes } from "./order-notes";

vi.mock("sonner", async () => (await import("@/test/fixtures/orders")).sonnerMock);

type Order = Schema<"AdminOrderView">;

const NOTES = "/api/v1/admin/orders/{order_id}/notes" as const;

function renderNotes(order: Order = adminOrder(), me = staff()) {
  const onSaved = vi.fn();
  const onChange = vi.fn();
  renderWithMe(<OrderNotes order={order} onSaved={onSaved} onChange={onChange} />, { me });
  return { onSaved, onChange, user: userEvent.setup() };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("OrderNotes", () => {
  it("shows the customer's note and an empty internal note", () => {
    renderNotes(adminOrder({ customer_note: "Leave with the porter" }));
    expect(screen.getByText("From the customer")).toBeInTheDocument();
    expect(screen.getByText("Leave with the porter")).toBeInTheDocument();
    expect(screen.getByText("No note.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add note" })).toBeInTheDocument();
  });

  it("is read-only for staff who cannot fulfil", () => {
    renderNotes(
      adminOrder({ internal_note: "VIP" }),
      staff({ permissions: ["admin:access", "orders:read"] }),
    );
    expect(screen.getByText("VIP")).toBeInTheDocument();
    expect(screen.queryByText("From the customer")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /note/ })).not.toBeInTheDocument();
  });

  it("saves optimistically and hands back the server's order", async () => {
    let sent: unknown;
    const saved = adminOrder({ internal_note: "Gift wrap" });
    server.use(
      on("patch", NOTES, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(saved);
      }),
    );
    const { user, onChange, onSaved } = renderNotes();
    await user.click(screen.getByRole("button", { name: "Add note" }));
    await user.type(screen.getByLabelText("Internal note"), "  Gift wrap ");
    await user.click(screen.getByRole("button", { name: "Save note" }));

    expect(onChange).toHaveBeenCalledWith("Gift wrap");
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith(saved);
    });
    expect(sent).toEqual({ internal_note: "Gift wrap" });
    expect(toast.success).toHaveBeenCalledWith("Note saved", expect.anything());
    expect(screen.queryByLabelText("Internal note")).not.toBeInTheDocument();
  });

  it("removes a note saved empty", async () => {
    let sent: unknown;
    server.use(
      on("patch", NOTES, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(adminOrder());
      }),
    );
    const { user } = renderNotes(adminOrder({ internal_note: "Old" }));
    await user.click(screen.getByRole("button", { name: "Edit note" }));
    expect(screen.getByLabelText("Internal note")).toHaveValue("Old");
    await user.clear(screen.getByLabelText("Internal note"));
    await user.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Note removed", expect.anything());
    });
    expect(sent).toEqual({ internal_note: null });
  });

  it("puts the old note back and reopens the editor when saving fails", async () => {
    server.use(fail("patch", NOTES, { status: 500, title: "Server error" }));
    const { user, onChange, onSaved } = renderNotes(adminOrder({ internal_note: "Old" }));
    await user.click(screen.getByRole("button", { name: "Edit note" }));
    await user.clear(screen.getByLabelText("Internal note"));
    await user.type(screen.getByLabelText("Internal note"), "New");
    await user.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith("Old");
    });
    expect(onChange).toHaveBeenNthCalledWith(1, "New");
    expect(onSaved).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "The note was not saved. Server error",
      expect.anything(),
    );
    expect(await screen.findByLabelText("Internal note")).toHaveValue("Old");
  });

  it("discards a draft on cancel", async () => {
    const { user, onChange } = renderNotes(adminOrder({ internal_note: "Old" }));
    await user.click(screen.getByRole("button", { name: "Edit note" }));
    await user.type(screen.getByLabelText("Internal note"), " and more");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Old")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit note" }));
    expect(screen.getByLabelText("Internal note")).toHaveValue("Old");
    expect(onChange).not.toHaveBeenCalled();
  });
});
