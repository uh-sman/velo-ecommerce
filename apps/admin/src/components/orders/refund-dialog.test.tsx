import type { Schema } from "@velo/api-client";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SHIRT_ID,
  TOTE_ID,
  adminOrder,
  adminRefund,
  orderLine,
  toast,
  toteLine,
  usd,
} from "@/test/fixtures/orders";
import { fail, on, server } from "@/test/server";

import { RefundDialog, paymentLabel } from "./refund-dialog";

vi.mock("sonner", async () => (await import("@/test/fixtures/orders")).sonnerMock);

type Order = Schema<"AdminOrderView">;

const REFUNDS = "/api/v1/admin/orders/{order_id}/refunds" as const;

function renderDialog(order: Order = adminOrder()) {
  const onOpenChange = vi.fn();
  const onRefunded = vi.fn();
  const view = render(
    <RefundDialog order={order} open onOpenChange={onOpenChange} onRefunded={onRefunded} />,
  );
  return { ...view, onOpenChange, onRefunded, user: userEvent.setup() };
}

function shirtBox() {
  return screen.getByRole("checkbox", { name: /Linen shirt/ });
}

function qty(index: number) {
  const input = screen.getAllByLabelText("Qty")[index];
  if (!input) throw new Error(`no quantity input ${String(index)}`);
  return input;
}

function preview() {
  return screen.getByText("Refund total").closest("dl") as HTMLElement;
}

function refundHandler(
  refund: Schema<"AdminRefundView">,
  sent: { body: unknown; key: string | null }[] = [],
) {
  return on("post", REFUNDS, async ({ request }) => {
    sent.push({ body: await request.json(), key: request.headers.get("Idempotency-Key") });
    return HttpResponse.json(refund, { status: 201 });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("paymentLabel", () => {
  it("names the card, the method, the provider, or falls back", () => {
    expect(paymentLabel(adminOrder())).toBe("Visa •••• 4242");
    const payment = adminOrder().payment;
    if (!payment) throw new Error("fixture has a payment");
    expect(
      paymentLabel(
        adminOrder({ payment: { ...payment, card_brand: null, method: "bank_transfer" } }),
      ),
    ).toBe("bank transfer");
    expect(
      paymentLabel(adminOrder({ payment: { ...payment, card_last4: null, method: null } })),
    ).toBe("the stripe payment");
    expect(paymentLabel(adminOrder({ payment: null }))).toBe("the original payment method");
  });
});

describe("RefundDialog", () => {
  it("says how much is left and blocks review until something is chosen", () => {
    renderDialog();
    expect(screen.getByRole("dialog", { name: "Refund" })).toHaveTextContent(
      "Up to $50.00 can still be refunded to Visa •••• 4242.",
    );
    expect(screen.getByRole("button", { name: "Review refund" })).toBeDisabled();
    expect(qty(0)).toBeDisabled();
    expect(within(preview()).getAllByText("$0.00")).toHaveLength(2);
  });

  it("prefills every refundable unit and prices a partial quantity like the server", async () => {
    const { user } = renderDialog();
    await user.click(shirtBox());
    expect(shirtBox()).toBeChecked();
    expect(qty(0)).toHaveValue(3);
    expect(within(preview()).getAllByText("$30.00")).toHaveLength(2);

    await user.clear(qty(0));
    await user.type(qty(0), "1");
    expect(within(preview()).getAllByText("$10.00")).toHaveLength(2);
  });

  it("sends the refund with an idempotency key after a confirmation that names amount and card", async () => {
    const sent: { body: unknown; key: string | null }[] = [];
    server.use(refundHandler(adminRefund({ amount: usd(1500) }), sent));
    const { user, onRefunded, onOpenChange } = renderDialog();

    await user.click(shirtBox());
    await user.clear(qty(0));
    await user.type(qty(0), "1");
    await user.click(screen.getByRole("checkbox", { name: "Refund shipping" }));
    await user.selectOptions(screen.getByLabelText("Reason"), "defective");
    await user.type(screen.getByLabelText(/^Note/), "  Seam split  ");
    expect(within(preview()).getByText(/Shipping/)).toBeInTheDocument();
    expect(within(preview()).getByText("$10.00")).toBeInTheDocument();
    expect(within(preview()).getByText("$5.00")).toBeInTheDocument();
    expect(within(preview()).getByText("$15.00")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Review refund" }));
    expect(
      screen.getByRole("dialog", { name: "Refund $15.00 to Visa •••• 4242?" }),
    ).toHaveTextContent("This sends money back to the customer and cannot be undone.");
    expect(screen.queryByText(/Restocked units/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Refund $15.00" }));
    await waitFor(() => {
      expect(onRefunded).toHaveBeenCalled();
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({
      lines: [{ order_item_id: SHIRT_ID, quantity: 1, restock: false }],
      include_shipping: true,
      extra_amount: 0,
      reason: "defective",
      note: "Seam split",
    });
    expect(sent[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(toast.success).toHaveBeenCalledWith(
      "Refunded $15.00 to Visa •••• 4242",
      expect.anything(),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("refunds goodwill alone, without any lines", async () => {
    const sent: { body: unknown; key: string | null }[] = [];
    server.use(refundHandler(adminRefund({ amount: usd(500), lines: [] }), sent));
    const { user } = renderDialog();
    await user.type(screen.getByLabelText(/Extra amount \(USD\)/), "$5.00");
    expect(within(preview()).getByText("Extra")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review refund" }));
    await user.click(screen.getByRole("button", { name: "Refund $5.00" }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.body).toEqual({
      lines: [],
      include_shipping: false,
      extra_amount: 500,
      reason: "requested_by_customer",
    });
  });

  it("rejects a quantity beyond what is left, inline and linked to the input", async () => {
    const { user } = renderDialog();
    await user.click(shirtBox());
    await user.clear(qty(0));
    await user.type(qty(0), "5");
    await user.click(screen.getByRole("button", { name: "Review refund" }));
    expect(screen.getByText("Enter 1 to 3.")).toBeInTheDocument();
    expect(qty(0)).toHaveAttribute("aria-invalid", "true");
    expect(qty(0)).toHaveAccessibleDescription("Enter 1 to 3.");
    expect(screen.getByRole("dialog", { name: "Refund" })).toBeInTheDocument();
  });

  it("rejects a fractional or empty quantity on a chosen line", async () => {
    const { user } = renderDialog();
    await user.type(screen.getByLabelText(/Extra amount/), "1");
    await user.click(shirtBox());
    await user.clear(qty(0));
    await user.click(screen.getByRole("button", { name: "Review refund" }));
    expect(screen.getByText("Enter 1 to 3.")).toBeInTheDocument();
  });

  it("asks for a readable extra amount", async () => {
    const { user } = renderDialog();
    await user.click(shirtBox());
    await user.type(screen.getByLabelText(/Extra amount/), "abc");
    await user.click(screen.getByRole("button", { name: "Review refund" }));
    expect(screen.getByLabelText(/Extra amount/)).toHaveAccessibleDescription(
      expect.stringContaining("Enter an amount like 5.00."),
    );
  });

  it("warns when the refund is more than is left and will not review it", async () => {
    const { user } = renderDialog();
    await user.type(screen.getByLabelText(/Extra amount/), "60");
    expect(screen.getByText("That is more than the $50.00 left to refund.")).toBeInTheDocument();
    const review = screen.getByRole("button", { name: "Review refund" });
    expect(review).toBeDisabled();
    // Even a forced submit is caught by validation.
    fireEvent.submit(review.closest("form") as HTMLFormElement);
    expect(screen.getByRole("alert")).toHaveTextContent("At most $50.00 can still be refunded.");
  });

  it("refuses an empty refund even if the form is forced to submit", () => {
    renderDialog();
    const review = screen.getByRole("button", { name: "Review refund" });
    fireEvent.submit(review.closest("form") as HTMLFormElement);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Choose items, shipping or an extra amount to refund.",
    );
  });

  it("restocks only unshipped units, and says so before sending", async () => {
    const sent: { body: unknown; key: string | null }[] = [];
    server.use(refundHandler(adminRefund(), sent));
    const order = adminOrder({ lines: [orderLine({ quantity_fulfilled: 2 }), toteLine()] });
    const { user } = renderDialog(order);

    // The shipped tote cannot be restocked from here.
    const toteRestock = screen.getAllByRole("checkbox", { name: /Restock/ })[1];
    expect(toteRestock).toBeDisabled();

    await user.click(shirtBox());
    const shirtRestock = screen.getByRole("checkbox", { name: "Restock (max 1)" });
    await user.click(shirtRestock);
    await user.click(screen.getByRole("button", { name: "Review refund" }));
    expect(screen.getByText("Only 1 unshipped unit can be restocked.")).toBeInTheDocument();

    await user.clear(qty(0));
    await user.type(qty(0), "1");
    await user.click(screen.getByRole("button", { name: "Review refund" }));
    expect(
      screen.getByText("Restocked units go back into inventory and will not ship."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refund $10.00" }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.body).toMatchObject({
      lines: [{ order_item_id: SHIRT_ID, quantity: 1, restock: true }],
    });
  });

  it("pluralises the restock limit, and sends shipped units to a return", async () => {
    const order = adminOrder({ lines: [orderLine({ quantity: 5, quantity_fulfilled: 2 })] });
    const { user, rerender, onOpenChange, onRefunded } = renderDialog(order);
    await user.click(shirtBox());
    await user.click(screen.getByRole("checkbox", { name: "Restock (max 3)" }));
    await user.click(screen.getByRole("button", { name: "Review refund" }));
    expect(screen.getByText("Only 3 unshipped units can be restocked.")).toBeInTheDocument();

    // The order reloads underneath the open dialog: everything has now shipped.
    rerender(
      <RefundDialog
        order={adminOrder({ lines: [orderLine({ quantity: 5, quantity_fulfilled: 5 })] })}
        open
        onOpenChange={onOpenChange}
        onRefunded={onRefunded}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Review refund" }));
    expect(
      screen.getByText("These units have shipped — restock them through a return."),
    ).toBeInTheDocument();
  });

  it("shows a fully refunded line as done and keeps it out of reach", async () => {
    const order = adminOrder({
      admin_refunds: [
        adminRefund({ lines: [{ order_item_id: TOTE_ID, quantity: 1, amount: 1500 }] }),
        // Failed refunds do not count against the line.
        adminRefund({
          id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2",
          status: "failed",
          lines: [{ order_item_id: SHIRT_ID, quantity: 3, amount: 3000 }],
        }),
      ],
    });
    const { user } = renderDialog(order);
    const tote = screen.getByRole("checkbox", { name: /Canvas tote/ });
    expect(tote).toBeDisabled();
    expect(tote.closest("label")).toHaveTextContent("fully refunded");
    expect(shirtBox().closest("label")).toHaveTextContent("3 refundable");

    // Unticking keeps the typed quantity but drops the line from the refund.
    await user.click(shirtBox());
    await user.click(shirtBox());
    expect(qty(0)).toHaveValue(3);
    expect(qty(0)).toBeDisabled();
  });

  it("goes back from the confirmation to the form", async () => {
    const { user } = renderDialog();
    await user.click(shirtBox());
    await user.click(screen.getByRole("button", { name: "Review refund" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("dialog", { name: "Refund" })).toBeInTheDocument();
    expect(qty(0)).toHaveValue(3);
  });

  it("closes on cancel", async () => {
    const { user, onOpenChange } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("returns to the form with the server's reason when the refund exceeds the capture", async () => {
    server.use(
      fail("post", REFUNDS, {
        status: 409,
        slug: "refund-exceeds-capture",
        title: "Refund exceeds capture",
        errors: [{ field: "amount", code: "too_large", message: "Only $20.00 is left." }],
      }),
    );
    const { user, onRefunded } = renderDialog();
    await user.click(shirtBox());
    await user.click(screen.getByRole("button", { name: "Review refund" }));
    await user.click(screen.getByRole("button", { name: "Refund $30.00" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Only $20.00 is left.");
    expect(screen.getByRole("dialog", { name: "Refund" })).toBeInTheDocument();
    expect(onRefunded).not.toHaveBeenCalled();
  });

  it("puts a per-line quantity problem next to its line", async () => {
    server.use(
      fail("post", REFUNDS, {
        status: 409,
        slug: "quantity-exceeded",
        title: "Quantity exceeded",
        detail: "One line has fewer units left.",
        errors: [{ field: `lines.${SHIRT_ID}`, code: "too_many", message: "Only 2 left." }],
      }),
    );
    const { user } = renderDialog();
    await user.click(shirtBox());
    await user.click(screen.getByRole("button", { name: "Review refund" }));
    await user.click(screen.getByRole("button", { name: "Refund $30.00" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("One line has fewer units left.");
    expect(qty(0)).toHaveAccessibleDescription("Only 2 left.");
  });

  it("stays on the confirmation with the problem for any other refusal", async () => {
    server.use(
      fail("post", REFUNDS, { status: 502, slug: "provider-error", title: "Provider unavailable" }),
    );
    const { user } = renderDialog();
    await user.click(shirtBox());
    await user.click(screen.getByRole("button", { name: "Review refund" }));
    await user.click(screen.getByRole("button", { name: "Refund $30.00" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Provider unavailable");
    expect(screen.getByRole("button", { name: "Refund $30.00" })).toBeEnabled();
  });

  it("retries an unanswered refund with the same key, and re-keys an edited one", async () => {
    const keys: (string | null)[] = [];
    let answer = false;
    server.use(
      on("post", REFUNDS, ({ request }) => {
        keys.push(request.headers.get("Idempotency-Key"));
        return answer
          ? HttpResponse.json(adminRefund({ amount: usd(2000) }), { status: 201 })
          : HttpResponse.error();
      }),
    );
    const { user, onRefunded } = renderDialog();
    await user.click(shirtBox());
    await user.click(screen.getByRole("button", { name: "Review refund" }));
    await user.click(screen.getByRole("button", { name: "Refund $30.00" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We could not reach the store, so we do not know whether the refund went through.",
    );

    await user.click(screen.getByRole("button", { name: "Refund $30.00" }));
    await waitFor(() => {
      expect(keys).toHaveLength(2);
    });
    expect(keys[1]).toBe(keys[0]);

    // A different refund must not reuse the key of the one that may have gone through.
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.clear(qty(0));
    await user.type(qty(0), "2");
    answer = true;
    await user.click(screen.getByRole("button", { name: "Review refund" }));
    await user.click(screen.getByRole("button", { name: "Refund $20.00" }));
    await waitFor(() => {
      expect(onRefunded).toHaveBeenCalled();
    });
    expect(keys).toHaveLength(3);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("explains a refund the provider has not confirmed yet", async () => {
    server.use(refundHandler(adminRefund({ status: "pending" })));
    const { user, onOpenChange } = renderDialog();
    await user.click(shirtBox());
    await user.click(screen.getByRole("button", { name: "Review refund" }));
    await user.click(screen.getByRole("button", { name: "Refund $30.00" }));
    const dialog = await screen.findByRole("dialog", { name: "Refund recorded" });
    expect(dialog).toHaveTextContent("Do not issue it again.");
    expect(onOpenChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("reports a declined refund with the provider's reason", async () => {
    server.use(refundHandler(adminRefund({ status: "failed", last_error: "card_expired" })));
    const { user, onOpenChange, onRefunded } = renderDialog();
    await user.click(shirtBox());
    await user.click(screen.getByRole("button", { name: "Review refund" }));
    await user.click(screen.getByRole("button", { name: "Refund $30.00" }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "The provider declined the refund: card_expired",
        expect.anything(),
      );
    });
    expect(onRefunded).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("reports a declined refund without a reason", async () => {
    server.use(refundHandler(adminRefund({ status: "failed", last_error: null })));
    const { user } = renderDialog();
    await user.click(shirtBox());
    await user.click(screen.getByRole("button", { name: "Review refund" }));
    await user.click(screen.getByRole("button", { name: "Refund $30.00" }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "The provider declined the refund.",
        expect.anything(),
      );
    });
  });

  it("will not close while the refund is in flight", async () => {
    let release: () => void = () => undefined;
    server.use(
      on("post", REFUNDS, async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return HttpResponse.json(adminRefund(), { status: 201 });
      }),
    );
    const { user, onOpenChange } = renderDialog();
    await user.click(shirtBox());
    await user.click(screen.getByRole("button", { name: "Review refund" }));
    await user.click(screen.getByRole("button", { name: "Refund $30.00" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    });
    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();
    release();
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});
