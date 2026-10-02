import type { Schema } from "@velo/api-client";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SHIRT_ID, TOTE_ID, returnView } from "@/test/fixtures/orders";

import { ReceiveDialog, RejectDialog } from "./return-dialogs";

type Received = Schema<"ReceivedLineIn">;

describe("RejectDialog", () => {
  function renderReject(result: string | null = null) {
    const onClose = vi.fn();
    const onReject = vi.fn<(note: string) => Promise<string | null>>(() => Promise.resolve(result));
    render(<RejectDialog rma="RMA-0001" onClose={onClose} onReject={onReject} />);
    return { onClose, onReject, user: userEvent.setup() };
  }

  it("needs a reason before it rejects", async () => {
    const { user, onReject } = renderReject();
    expect(screen.getByRole("dialog", { name: "Reject return RMA-0001?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reject return" }));
    const reason = screen.getByLabelText("Reason");
    expect(reason).toHaveAttribute("aria-invalid", "true");
    expect(reason).toHaveAccessibleDescription("Say why, so the customer and your team know.");
    expect(onReject).not.toHaveBeenCalled();
  });

  it("rejects with the trimmed reason and closes", async () => {
    const { user, onReject, onClose } = renderReject();
    await user.type(screen.getByLabelText("Reason"), "  Worn outside  ");
    await user.click(screen.getByRole("button", { name: "Reject return" }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(onReject).toHaveBeenCalledWith("Worn outside");
  });

  it("stays open with the failure", async () => {
    const { user, onClose } = renderReject("Return already closed");
    await user.type(screen.getByLabelText("Reason"), "No");
    await user.click(screen.getByRole("button", { name: "Reject return" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Return already closed");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on cancel and on escape", async () => {
    const { user, onClose } = renderReject();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("ReceiveDialog", () => {
  const returned = returnView({
    lines: [
      {
        order_item_id: SHIRT_ID,
        product_title: "Linen shirt",
        variant_title: "M",
        sku: "SH-M",
        quantity: 2,
        condition: null,
        restock: false,
      },
      {
        order_item_id: TOTE_ID,
        product_title: "Canvas tote",
        variant_title: "",
        sku: "TOTE",
        quantity: 1,
        condition: null,
        restock: false,
      },
    ],
  });

  function renderReceive({
    result = null,
    loading = false,
  }: { result?: string | null; loading?: boolean } = {}) {
    const onClose = vi.fn();
    const onReceive = vi.fn<(lines: Received[], note: string) => Promise<string | null>>(() =>
      Promise.resolve(result),
    );
    render(
      <ReceiveDialog
        returned={returned}
        lineTitle={(id) => (id === SHIRT_ID ? "Linen shirt · M" : "Canvas tote")}
        loading={loading}
        onClose={onClose}
        onReceive={onReceive}
      />,
    );
    return { onClose, onReceive, user: userEvent.setup() };
  }

  function condition(index: number) {
    const select = screen.getAllByLabelText("Condition")[index];
    if (!select) throw new Error(`no condition ${String(index)}`);
    return select;
  }

  it("lists each returned line, restock off by default", () => {
    renderReceive({ loading: true });
    expect(screen.getByRole("dialog", { name: "Receive return RMA-0001" })).toBeInTheDocument();
    expect(screen.getByText("Loading item names…")).toBeInTheDocument();
    expect(screen.getByText("2 × Linen shirt · M")).toBeInTheDocument();
    expect(screen.getByText("1 × Canvas tote")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Put them back in stock" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Put it back in stock" })).not.toBeChecked();
  });

  it("asks for every line's condition", async () => {
    const { user, onReceive } = renderReceive();
    await user.selectOptions(condition(0), "new");
    await user.click(screen.getByRole("button", { name: "Mark received" }));
    expect(screen.getAllByText("Choose the condition it arrived in.")).toHaveLength(1);
    expect(condition(1)).toHaveAttribute("aria-invalid", "true");
    expect(condition(0)).not.toHaveAttribute("aria-invalid");
    expect(onReceive).not.toHaveBeenCalled();
  });

  it("never restocks damaged goods", async () => {
    const { user } = renderReceive();
    const restock = screen.getByRole("checkbox", { name: "Put them back in stock" });
    await user.click(restock);
    expect(restock).toBeChecked();
    await user.selectOptions(condition(0), "damaged");
    expect(restock).not.toBeChecked();
    expect(restock).toBeDisabled();
  });

  it("sends each line's inspection and the note, then closes", async () => {
    const { user, onReceive, onClose } = renderReceive();
    await user.selectOptions(condition(0), "opened");
    await user.click(screen.getByRole("checkbox", { name: "Put them back in stock" }));
    await user.selectOptions(condition(1), "damaged");
    await user.type(screen.getByLabelText(/Staff note/), " Tags missing ");
    await user.click(screen.getByRole("button", { name: "Mark received" }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(onReceive).toHaveBeenCalledWith(
      [
        { order_item_id: SHIRT_ID, condition: "opened", restock: true },
        { order_item_id: TOTE_ID, condition: "damaged", restock: false },
      ],
      "Tags missing",
    );
  });

  it("stays open with the failure", async () => {
    const { user, onClose } = renderReceive({ result: "Return is not approved" });
    await user.selectOptions(condition(0), "new");
    await user.selectOptions(condition(1), "new");
    await user.click(screen.getByRole("button", { name: "Mark received" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Return is not approved");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on cancel and on escape", async () => {
    const { user, onClose } = renderReceive();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
