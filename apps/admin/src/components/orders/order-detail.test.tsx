import type { Schema } from "@velo/api-client";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ORDER_ID,
  SHIRT_ID,
  adminOrder,
  adminRefund,
  orderLine,
  returnView,
  shipment,
  toast,
  toteLine,
  usd,
} from "@/test/fixtures/orders";
import { renderWithMe, staff } from "@/test/render";
import { fail, ok, on, server } from "@/test/server";

import { OrderDetail } from "./order-detail";

vi.mock("sonner", async () => (await import("@/test/fixtures/orders")).sonnerMock);

type Order = Schema<"AdminOrderView">;

const ORDER = "/api/v1/admin/orders/{order_id}" as const;
const READER = staff({ role: "support", permissions: ["admin:access", "orders:read"] });

/** Answers each GET of the order with the next of `orders`, then keeps answering with the last. */
function serveOrder(...orders: Order[]) {
  let calls = 0;
  server.use(
    on("get", ORDER, () => {
      const order = orders[Math.min(calls, orders.length - 1)];
      calls += 1;
      return HttpResponse.json(order);
    }),
  );
  return { calls: () => calls };
}

async function renderDetail(order: Order = adminOrder(), me = staff()) {
  const served = serveOrder(order);
  renderWithMe(<OrderDetail id={ORDER_ID} />, { me });
  await screen.findByRole("heading", { name: `Order ${order.number}` });
  return { ...served, user: userEvent.setup() };
}

function section(title: string) {
  const heading = screen.getByRole("heading", { name: title, level: 2 });
  return heading.closest("section") as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("OrderDetail", () => {
  it("loads the order and shows its states, items and totals", async () => {
    serveOrder(
      adminOrder({
        cancelled_at: "2026-09-05T10:00:00Z",
        discount_code: "SUMMER",
        lines: [orderLine({ discount: usd(100) }), toteLine()],
        totals: {
          subtotal: usd(4500),
          discount: usd(100),
          shipping: usd(500),
          tax: usd(0),
          total: usd(4900),
          refunded: usd(1000),
        },
        refundable: usd(3900),
      }),
    );
    renderWithMe(<OrderDetail id={ORDER_ID} />);
    expect(screen.getByLabelText("Loading order")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Order VELO-1001" })).toBeInTheDocument();
    expect(screen.getByText(/cancelled/)).toBeInTheDocument();
    expect(screen.getByText("Confirmed")).toBeInTheDocument();
    expect(screen.getByText("Paid")).toBeInTheDocument();

    const items = within(section("Items")).getByRole("table", { name: "Items" });
    const [shirt, tote] = within(items).getAllByRole("row").slice(1);
    expect(shirt).toHaveTextContent("Linen shirt");
    expect(shirt).toHaveTextContent("M · SH-M");
    expect(shirt).toHaveTextContent("incl. −$1.00");
    expect(tote).toHaveTextContent("Canvas tote");
    expect(tote).toHaveTextContent("TOTE");

    const summary = section("Items");
    expect(summary).toHaveTextContent("Discount (SUMMER)−$1.00");
    expect(summary).toHaveTextContent("Shipping · Standard$5.00");
    expect(summary).toHaveTextContent("Total$49.00");
    expect(summary).toHaveTextContent("Refunded−$10.00");
    expect(summary).toHaveTextContent("Left to refund$39.00");

    expect(screen.getByRole("link", { name: "Invoice" })).toHaveAttribute(
      "href",
      `http://localhost:8000/api/v1/admin/orders/${ORDER_ID}/invoice`,
    );
    expect(screen.getByRole("link", { name: "Packing slip" })).toHaveAttribute(
      "href",
      `http://localhost:8000/api/v1/admin/orders/${ORDER_ID}/packing-slip`,
    );
    expect(within(section("Shipments")).getByText("Nothing has shipped yet.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Refunds" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Returns" })).not.toBeInTheDocument();
  });

  it("says when there is no such order", async () => {
    server.use(fail("get", ORDER, { status: 404, slug: "not-found", title: "Not found" }));
    renderWithMe(<OrderDetail id="nope" />);
    expect(await screen.findByText("No such order")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to orders" })).toHaveAttribute("href", "/orders");
  });

  it("treats a malformed id as no such order", async () => {
    server.use(fail("get", ORDER, { status: 422, title: "Invalid" }));
    renderWithMe(<OrderDetail id="not-a-uuid" />);
    expect(await screen.findByText("No such order")).toBeInTheDocument();
  });

  it("can retry after a failed load", async () => {
    server.use(fail("get", ORDER, { status: 500, title: "Server error" }));
    renderWithMe(<OrderDetail id={ORDER_ID} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We could not load this order. Server error",
    );
    serveOrder(adminOrder());
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Order VELO-1001" })).toBeInTheDocument();
  });

  it("shows read-only staff no actions", async () => {
    await renderDetail(adminOrder({ user_id: "u1" }), READER);
    expect(screen.queryByRole("button", { name: "Fulfil items" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refund" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add note" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "View customer" })).not.toBeInTheDocument();
    expect(screen.getByText("Has an account")).toBeInTheDocument();
  });

  it("blocks fulfilment while the payment is disputed", async () => {
    await renderDetail(adminOrder({ metadata: { dispute: { open: true } } }));
    expect(screen.getByRole("alert")).toHaveTextContent("This payment is disputed");
    expect(screen.queryByRole("button", { name: "Fulfil items" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refund" })).toBeInTheDocument();
  });

  it("offers neither fulfilment nor refund when nothing is left to do", async () => {
    await renderDetail(
      adminOrder({
        status: "delivered",
        lines: [orderLine({ quantity_fulfilled: 3 }), toteLine()],
        refundable: usd(0),
        payment: null,
        metadata: { dispute: { open: false } },
      }),
    );
    expect(screen.queryByRole("button", { name: "Fulfil items" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refund" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument();
    expect(within(section("Payment")).getByText("No payment has been captured.")).toBeVisible();
  });

  it("shows the refund history, newest first, and flags refunds that need attention", async () => {
    await renderDetail(
      adminOrder({
        admin_refunds: [
          adminRefund({
            id: "r-old",
            created_at: "2026-09-02T10:00:00Z",
            lines: [{ order_item_id: SHIRT_ID, quantity: 1, amount: 1000, restock: true }],
            note: "Customer called",
          }),
          adminRefund({
            id: "r-new",
            created_at: "2026-09-03T10:00:00Z",
            status: "pending",
            attempts: 3,
            last_error: "timeout",
            reason: "goodwill_gesture",
            provider_refund_id: null,
            return_id: "ret-1",
            lines: [{ order_item_id: "gone", quantity: 2, amount: 0 }],
          }),
          adminRefund({
            id: "r-failed",
            created_at: "2026-09-01T10:00:00Z",
            status: "failed",
            reason: "duplicate",
            lines: [],
          }),
        ],
      }),
    );
    const alerts = screen.getAllByRole("alert");
    expect(alerts.some((alert) => alert.textContent?.includes("2 refunds need attention"))).toBe(
      true,
    );
    const history = within(section("Refunds"))
      .getAllByRole("listitem")
      .filter((item) => item.querySelector("time"));
    expect(history).toHaveLength(3);
    const [newest, middle, oldest] = history;
    expect(newest).toHaveTextContent("Pending");
    expect(newest).toHaveTextContent("· from a return");
    expect(newest).toHaveTextContent("goodwill gesture");
    expect(newest).toHaveTextContent("2 × Item");
    expect(newest).toHaveTextContent("3 attempts · timeout");
    expect(middle).toHaveTextContent("Requested by customer · re_123");
    expect(middle).toHaveTextContent("1 × Linen shirt · restocked");
    expect(middle).toHaveTextContent("“Customer called”");
    expect(middle).not.toHaveTextContent("attempt");
    expect(oldest).toHaveTextContent("Failed");
    expect(oldest).toHaveTextContent("Duplicate charge");
    expect(oldest).toHaveTextContent("1 attempt");
  });

  it("names a single stuck refund in the singular", async () => {
    await renderDetail(adminOrder({ admin_refunds: [adminRefund({ status: "failed" })] }));
    expect(screen.getByRole("alert")).toHaveTextContent("1 refund needs attention");
  });

  it("lists the order's returns with a link to the queue", async () => {
    await renderDetail(
      adminOrder({
        returns: [
          returnView({ status: "refunded", refund_amount: usd(1500) }),
          returnView({ id: "r2", rma_number: "RMA-0002", reason: "not_as_described" }),
        ],
      }),
    );
    const returns = section("Returns");
    expect(within(returns).getByRole("link", { name: "Returns queue" })).toHaveAttribute(
      "href",
      "/returns",
    );
    const [first, second] = within(returns).getAllByRole("listitem");
    expect(first).toHaveTextContent("RMA-0001");
    expect(first).toHaveTextContent("wrong size");
    expect(first).toHaveTextContent("Refunded $15.00");
    expect(second).toHaveTextContent("not as described");
    expect(second).not.toHaveTextContent("Refunded $");
  });

  it("shows the customer, their addresses and how to reach them", async () => {
    await renderDetail(
      adminOrder({
        user_id: "u1",
        billing_address: { first_name: "Ada", last_name: "Lovelace", line1: "2 Billing Rd" },
      }),
    );
    const customer = section("Customer");
    expect(customer).toHaveTextContent("Ada Lovelace");
    expect(customer).toHaveTextContent("Has an account");
    expect(within(customer).getByRole("link", { name: "Contact" })).toHaveAttribute(
      "href",
      "mailto:ada@example.com?subject=Order%20VELO-1001",
    );
    expect(within(customer).getByRole("link", { name: "View customer" })).toHaveAttribute(
      "href",
      "/customers/u1",
    );
    expect(customer).toHaveTextContent("1 Analytical Way");
    expect(customer).toHaveTextContent("2 Billing Rd");
    expect(customer).not.toHaveTextContent("Same as delivery");

    const payment = section("Payment");
    expect(payment).toHaveTextContent("Visa •••• 4242");
    expect(payment).toHaveTextContent("stripe");
    expect(payment).toHaveTextContent("Captured$50.00");
  });

  it("says when a guest gave no delivery address and billing matches", async () => {
    await renderDetail(adminOrder({ shipping_address: {}, billing_address: {} }));
    const customer = section("Customer");
    expect(customer).toHaveTextContent("Guest checkout");
    expect(customer).toHaveTextContent("None");
    expect(customer).toHaveTextContent("Same as delivery");
  });

  it("fulfils items and quietly reloads the order", async () => {
    const shipped = adminOrder({
      status: "fulfilled",
      lines: [orderLine({ quantity_fulfilled: 3 }), toteLine()],
      shipments: [shipment({ lines: [{ order_item_id: SHIRT_ID, quantity: 3 }] })],
    });
    serveOrder(adminOrder(), shipped);
    server.use(ok("post", "/api/v1/admin/orders/{order_id}/fulfilments", shipment(), 201));
    renderWithMe(<OrderDetail id={ORDER_ID} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Fulfil items" }));
    await user.click(screen.getByRole("button", { name: "Create parcel" }));
    await screen.findByRole("dialog", { name: "Parcel created" });
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Fulfil items" })).not.toBeInTheDocument();
    });
    expect(within(section("Shipments")).getByText(/3 × Linen shirt/)).toHaveTextContent(
      "3 × Linen shirt · M",
    );
    expect(screen.queryByLabelText("Loading order")).not.toBeInTheDocument();
  });

  it("warns when the quiet reload fails, keeping what it has", async () => {
    let calls = 0;
    server.use(
      on("get", ORDER, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json(adminOrder({ shipments: [shipment()] }))
          : HttpResponse.json({ type: "x", title: "Down", status: 503 }, { status: 503 });
      }),
      ok("patch", "/api/v1/admin/fulfilments/{fulfilment_id}", shipment({ status: "delivered" })),
    );
    renderWithMe(<OrderDetail id={ORDER_ID} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Update" }));
    await user.selectOptions(screen.getByLabelText("Status"), "delivered");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Could not refresh the order. Reload the page to see the latest.",
        expect.anything(),
      );
    });
    expect(screen.getByRole("heading", { name: "Order VELO-1001" })).toBeInTheDocument();
  });

  it("refunds through the dialog and reloads the order", async () => {
    const refunded = adminOrder({
      payment_status: "partially_refunded",
      admin_refunds: [
        adminRefund({
          amount: usd(3000),
          lines: [{ order_item_id: SHIRT_ID, quantity: 3, amount: 3000 }],
        }),
      ],
      refundable: usd(2000),
    });
    const served = serveOrder(adminOrder(), refunded);
    server.use(
      ok(
        "post",
        "/api/v1/admin/orders/{order_id}/refunds",
        adminRefund({ amount: usd(3000) }),
        201,
      ),
    );
    renderWithMe(<OrderDetail id={ORDER_ID} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Refund" }));
    await user.click(screen.getByRole("checkbox", { name: /Linen shirt/ }));
    await user.click(screen.getByRole("button", { name: "Review refund" }));
    await user.click(screen.getByRole("button", { name: "Refund $30.00" }));
    expect(await screen.findByRole("heading", { name: "Refunds" })).toBeInTheDocument();
    expect(served.calls()).toBe(2);
    expect(screen.getByText("Partly refunded")).toBeInTheDocument();
  });

  it("marks a paid order as preparing after confirmation", async () => {
    let sent: unknown;
    server.use(
      on("post", "/api/v1/admin/orders/{order_id}/status", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(adminOrder({ status: "processing" }));
      }),
    );
    const { user } = await renderDetail();
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(await screen.findByRole("menuitem", { name: "Mark as preparing" }));
    const dialog = await screen.findByRole("dialog", { name: "Mark as preparing?" });
    expect(dialog).toHaveTextContent("Tells the customer their order is being prepared.");
    await user.click(within(dialog).getByRole("button", { name: "Mark preparing" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(sent).toEqual({ status: "processing" });
    expect(toast.success).toHaveBeenCalledWith("Marked as preparing", expect.anything());
    expect(screen.getByText("Preparing")).toBeInTheDocument();
  });

  it("marks a shipped order delivered, and shows a refusal in the dialog", async () => {
    server.use(
      fail("post", "/api/v1/admin/orders/{order_id}/status", {
        status: 409,
        slug: "invalid-transition",
        title: "Invalid transition",
        detail: "Parcels are still in transit.",
      }),
    );
    const { user } = await renderDetail(
      adminOrder({
        status: "fulfilled",
        lines: [orderLine({ quantity_fulfilled: 3 }), toteLine()],
      }),
    );
    await user.click(screen.getByRole("button", { name: "More" }));
    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Mark as delivered"]);
    await user.click(within(menu).getByRole("menuitem", { name: "Mark as delivered" }));
    const dialog = await screen.findByRole("dialog", { name: "Mark as delivered?" });
    await user.click(within(dialog).getByRole("button", { name: "Mark delivered" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Parcels are still in transit.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("marks delivered successfully", async () => {
    server.use(
      ok("post", "/api/v1/admin/orders/{order_id}/status", adminOrder({ status: "delivered" })),
    );
    const { user } = await renderDetail(adminOrder({ status: "fulfilled" }));
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(await screen.findByRole("menuitem", { name: "Mark as delivered" }));
    await user.click(await screen.findByRole("button", { name: "Mark delivered" }));
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Marked as delivered", expect.anything());
    });
  });

  it("cancels and refunds an order, naming the amount and the card", async () => {
    let sent: unknown;
    server.use(
      on("post", "/api/v1/admin/orders/{order_id}/cancel", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(adminOrder({ status: "cancelled" }));
      }),
    );
    const { user } = await renderDetail();
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(await screen.findByRole("menuitem", { name: "Cancel order…" }));
    const dialog = await screen.findByRole("dialog", { name: "Cancel order VELO-1001?" });
    expect(dialog).toHaveTextContent(
      "the customer is refunded everything — $50.00 to Visa •••• 4242",
    );
    await user.click(within(dialog).getByRole("button", { name: "Cancel order and refund" }));
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Order VELO-1001 cancelled", expect.anything());
    });
    expect(sent).toEqual({});
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
  });

  it("explains cancelling an unpaid order, and reports a refusal", async () => {
    server.use(
      fail("post", "/api/v1/admin/orders/{order_id}/cancel", {
        status: 409,
        title: "Already shipped",
      }),
    );
    const { user } = await renderDetail(
      adminOrder({
        status: "pending",
        payment_status: "pending",
        refundable: usd(0),
        payment: null,
      }),
    );
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(await screen.findByRole("menuitem", { name: "Cancel order…" }));
    const dialog = await screen.findByRole("dialog", { name: "Cancel order VELO-1001?" });
    expect(dialog).toHaveTextContent("Nothing was paid, so nothing is refunded.");
    await user.click(within(dialog).getByRole("button", { name: "Cancel order and refund" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Already shipped");
  });

  it("keeps a note edit in the page and takes the server's order after saving", async () => {
    server.use(
      ok(
        "patch",
        "/api/v1/admin/orders/{order_id}/notes",
        adminOrder({ internal_note: "Fragile" }),
      ),
    );
    const { user } = await renderDetail();
    const notes = section("Notes");
    await user.click(within(notes).getByRole("button", { name: "Add note" }));
    await user.type(within(notes).getByLabelText("Internal note"), "Fragile");
    await user.click(within(notes).getByRole("button", { name: "Save note" }));
    expect(await within(notes).findByText("Fragile")).toBeInTheDocument();
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Note saved", expect.anything());
    });
    expect(within(notes).getByRole("button", { name: "Edit note" })).toBeInTheDocument();
  });
});
