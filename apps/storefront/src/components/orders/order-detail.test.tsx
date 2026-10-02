import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OrderDetail } from "@/components/orders/order-detail";
import {
  makeLine,
  makeOrder,
  makeReturn,
  makeShipment,
  usd,
} from "@/test/fixtures/checkout-orders";
import { router } from "@/test/navigation";
import { fail, on, server } from "@/test/server";

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
vi.mock("@/components/ui/sonner", () => ({ notify: toast }));

beforeEach(() => {
  for (const fn of Object.values(toast)) fn.mockReset();
});

function progress() {
  return within(screen.getByRole("list", { name: "Order progress" }))
    .getAllByRole("listitem")
    .map((item) => item.textContent);
}

describe("OrderDetail", () => {
  it("shows a paid, unshipped order with its summary, address and payment", () => {
    render(<OrderDetail initial={makeOrder()} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Order VLO-ABC123");
    expect(screen.getAllByText("Confirmed")[0]).toBeInTheDocument();
    const steps = progress();
    expect(steps[0]).toMatch(/^Ordered · /);
    expect(steps.slice(1)).toEqual(["Shipped (not yet)", "Delivered (not yet)"]);

    const items = screen.getByRole("region", { name: "Items" });
    expect(within(items).getByText("Trail Runner")).toBeInTheDocument();
    expect(within(items).getByText("Size 9 · × 2")).toBeInTheDocument();

    const summary = screen.getByRole("region", { name: "Summary" });
    expect(within(summary).getByText("Shipping — Standard")).toBeInTheDocument();
    expect(within(summary).getByText("$95.00")).toBeInTheDocument();
    expect(within(summary).queryByText(/Discount/)).not.toBeInTheDocument();
    expect(within(summary).queryByText("Refunded")).not.toBeInTheDocument();

    const address = screen.getByRole("region", { name: "Delivery address" });
    expect(address).toHaveTextContent("Ada Lovelace1 Market StSan Francisco, CA, 94103US");
    expect(screen.getByRole("region", { name: "Payment" })).toHaveTextContent("VISA •••• 4242");

    expect(screen.getByRole("link", { name: "Invoice (PDF)" })).toHaveAttribute(
      "href",
      "http://localhost:8000/api/v1/orders/VLO-ABC123/invoice",
    );
    expect(screen.queryByRole("button", { name: "Request a return" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel order" })).not.toBeInTheDocument();
  });

  it("groups a partly shipped order by parcel with each parcel's tracking", () => {
    const order = makeOrder({
      status: "partially_fulfilled",
      access_token: "tok-1",
      lines: [
        makeLine({ quantity: 2, quantity_fulfilled: 2 }),
        makeLine({
          id: "line-2",
          product_title: "Wool Sock",
          variant_title: "M",
          quantity: 3,
          quantity_fulfilled: 1,
          image_url: "https://cdn.example/sock.jpg",
        }),
      ],
      shipments: [
        makeShipment({
          tracking_url: "https://ups.example/1Z999",
          delivered_at: "2026-09-04T10:00:00Z",
        }),
        makeShipment({
          id: "shp-2",
          status: "delivered",
          carrier: "dhl",
          tracking_number: "JD0001",
          shipped_at: "2026-09-01T12:00:00Z",
          lines: [
            { order_item_id: "line-2", quantity: 1 },
            { order_item_id: "gone", quantity: 1 },
          ],
        }),
      ],
    });
    render(<OrderDetail initial={order} />);

    const first = screen.getByRole("region", { name: /Parcel 1/ });
    expect(within(first).getByRole("link", { name: "Track with UPS" })).toHaveAttribute(
      "href",
      "https://ups.example/1Z999",
    );
    expect(within(first).getByText("Shipped")).toBeInTheDocument();
    const second = screen.getByRole("region", { name: /Parcel 2/ });
    expect(second).toHaveTextContent("dhl tracking number: JD0001");
    expect(within(second).getAllByRole("listitem")).toHaveLength(1);

    const rest = screen.getByRole("region", { name: "Still to ship" });
    expect(within(rest).getByText("M · × 2")).toBeInTheDocument();
    expect(within(rest).getByRole("presentation")).toHaveAttribute(
      "src",
      "https://cdn.example/sock.jpg",
    );

    // The earliest shipment marks "Shipped"; one parcel is undelivered, so "Delivered" is not done.
    const steps = progress();
    expect(steps[1]).toMatch(/^Shipped · /);
    expect(steps[2]).toBe("Delivered (not yet)");
    expect(screen.getByRole("link", { name: "Invoice (PDF)" })).toHaveAttribute(
      "href",
      "http://localhost:8000/api/v1/orders/VLO-ABC123/invoice?token=tok-1",
    );
  });

  it("marks the order delivered once every parcel has arrived", () => {
    render(
      <OrderDetail
        initial={makeOrder({
          status: "delivered",
          lines: [makeLine({ quantity_fulfilled: 2 })],
          shipments: [
            makeShipment({ tracking_number: null, delivered_at: "2026-09-05T10:00:00Z" }),
          ],
        })}
      />,
    );
    expect(screen.getByRole("region", { name: /Your parcel/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Still to ship" })).not.toBeInTheDocument();
    expect(progress()[2]).toMatch(/^Delivered · /);
  });

  it("treats a delivered status as delivered even without parcels", () => {
    render(<OrderDetail initial={makeOrder({ status: "delivered", shipments: [] })} />);
    expect(progress()[2]).toBe("Delivered");
  });

  it("lists everything on a cancelled order, with its refunds and discount", () => {
    render(
      <OrderDetail
        initial={makeOrder({
          status: "cancelled",
          cancelled_at: "2026-09-02T09:00:00Z",
          discount_code: "SAVE10",
          lines: [makeLine({ quantity_refunded: 2, quantity_returned: 1 })],
          refunds: [
            {
              id: "rf-1",
              amount: usd(9500),
              status: "pending",
              reason: "cancelled",
              return_id: null,
              created_at: "2026-09-02T09:00:00Z",
            },
          ],
          payment: {
            provider: "paystack",
            method: "bank_transfer",
            card_brand: null,
            card_last4: null,
            captured: usd(9500),
            refunded: usd(9500),
          },
          totals: {
            subtotal: usd(10000),
            discount: usd(1000),
            shipping: usd(500),
            tax: usd(0),
            total: usd(9500),
            refunded: usd(9500),
          },
        })}
      />,
    );
    const items = screen.getByRole("region", { name: "Cancelled items" });
    expect(within(items).getByText("Size 9 · × 2")).toBeInTheDocument();
    expect(within(items).getByText("1 returned")).toBeInTheDocument();
    const steps = progress();
    expect(steps[1]).toMatch(/^Cancelled · /);
    expect(steps[2]).toMatch(/^Refunded \$95\.00 \(processing\) · /);
    const summary = screen.getByRole("region", { name: "Summary" });
    expect(within(summary).getByText("Discount (SAVE10)")).toBeInTheDocument();
    expect(within(summary).getByText("−$10.00")).toBeInTheDocument();
    expect(within(summary).getByText("Refunded")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Payment" })).toHaveTextContent("bank_transfer");
  });

  it("falls back to generic labels when details are missing", () => {
    render(
      <OrderDetail
        initial={makeOrder({
          shipping_method: null,
          payment: null,
          shipping_address: { first_name: 7, line1: "1 Market St", country_code: "US" },
          refunds: [
            {
              id: "rf-1",
              amount: usd(500),
              status: "succeeded",
              reason: "goodwill",
              return_id: null,
              created_at: "2026-09-03T09:00:00Z",
            },
          ],
          totals: {
            subtotal: usd(9000),
            discount: usd(500),
            shipping: usd(500),
            tax: usd(0),
            total: usd(9000),
            refunded: usd(0),
          },
        })}
      />,
    );
    expect(screen.getByRole("region", { name: "Payment" })).toHaveTextContent("Paid");
    expect(screen.getByText("Shipping")).toBeInTheDocument();
    expect(screen.getByText("Discount")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Delivery address" })).toHaveTextContent(
      "1 Market StUS",
    );
    expect(progress()[3]).toMatch(/^Refunded \$5\.00 · /);
  });

  it("shows each return with what to do next", () => {
    render(
      <OrderDetail
        initial={makeOrder({
          access_token: "tok-1",
          returns: [
            makeReturn({ status: "approved" }),
            makeReturn({
              id: "ret-2",
              rma_number: "RMA-0002",
              status: "rejected",
              staff_note: "Worn outdoors",
              lines: [
                {
                  order_item_id: "unknown",
                  product_title: "x",
                  variant_title: "x",
                  sku: "x",
                  quantity: 2,
                  condition: null,
                  restock: false,
                },
              ],
            }),
            makeReturn({
              id: "ret-3",
              rma_number: "RMA-0003",
              status: "closed",
              refund_amount: usd(4500),
            }),
          ],
        })}
      />,
    );
    const returns = within(screen.getByRole("region", { name: "Returns" })).getAllByRole(
      "listitem",
    );
    const [approved, rejected, closed] = returns;
    if (!approved || !rejected || !closed) throw new Error("expected three returns");
    expect(approved).toHaveTextContent("1 × Trail Runner");
    expect(approved).toHaveTextContent("Write RMA-0001 on the outside.");
    expect(within(approved).getByRole("link", { name: "Print return label" })).toHaveAttribute(
      "href",
      "http://localhost:8000/api/v1/orders/VLO-ABC123/returns/RMA-0001/label?token=tok-1",
    );
    expect(rejected).toHaveTextContent("2 × item");
    expect(rejected).toHaveTextContent("Reason: Worn outdoors");
    expect(within(rejected).getByText("Rejected")).toBeInTheDocument();
    expect(closed).toHaveTextContent("Refund of $45.00 issued");
  });

  describe("cancelling", () => {
    const cancellable = makeOrder({ can_cancel: true, access_token: "tok-1" });

    async function openDialog() {
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Cancel order" }));
      const dialog = await screen.findByRole("dialog", { name: "Cancel order VLO-ABC123?" });
      return { user, dialog };
    }

    it("states the refund and can be dismissed", async () => {
      render(<OrderDetail initial={cancellable} />);
      const { user, dialog } = await openDialog();
      expect(dialog).toHaveTextContent("Everything you paid, $95.00, goes back");
      await user.click(within(dialog).getByRole("button", { name: "Keep my order" }));
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });
    });

    it("cancels with the signed token and shows the updated order", async () => {
      let url: URL | undefined;
      server.use(
        on("post", "/api/v1/orders/{number}/cancel", ({ request }) => {
          url = new URL(request.url);
          return HttpResponse.json(
            makeOrder({ status: "cancelled", cancelled_at: "2026-09-02T09:00:00Z" }),
          );
        }),
      );
      render(<OrderDetail initial={cancellable} />);
      const { user, dialog } = await openDialog();
      await user.click(within(dialog).getByRole("button", { name: "Cancel order" }));
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });
      expect(url?.searchParams.get("token")).toBe("tok-1");
      expect(toast.success).toHaveBeenCalledWith(
        "Your order is cancelled. The refund is on its way.",
      );
      expect(screen.getByRole("region", { name: "Cancelled items" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Cancel order" })).not.toBeInTheDocument();
    });

    it("explains why the order was not cancelled", async () => {
      server.use(
        fail("post", "/api/v1/orders/{number}/cancel", {
          status: 409,
          title: "Conflict",
          detail: "It has already shipped.",
        }),
      );
      render(<OrderDetail initial={makeOrder({ can_cancel: true })} />);
      const { user, dialog } = await openDialog();
      await user.click(within(dialog).getByRole("button", { name: "Cancel order" }));
      const alert = await within(dialog).findByRole("alert");
      expect(alert).toHaveTextContent("The order was not cancelled");
      expect(alert).toHaveTextContent("It has already shipped.");
    });

    it("uses the problem title when there is no detail", async () => {
      server.use(fail("post", "/api/v1/orders/{number}/cancel", { status: 500, title: "Oops" }));
      render(<OrderDetail initial={makeOrder({ can_cancel: true })} />);
      const { user, dialog } = await openDialog();
      await user.click(within(dialog).getByRole("button", { name: "Cancel order" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("Oops");
    });
  });

  describe("returning", () => {
    const returnable = makeOrder({
      can_return: true,
      access_token: "tok-1",
      status: "delivered",
      lines: [
        makeLine({ quantity_fulfilled: 2, returnable_quantity: 2 }),
        makeLine({
          id: "line-2",
          product_title: "Wool Sock",
          quantity_fulfilled: 1,
          quantity: 1,
          returnable_quantity: 0,
        }),
      ],
    });

    async function openDialog() {
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Request a return" }));
      const dialog = await screen.findByRole("dialog", { name: "Return items" });
      return { user, dialog };
    }

    it("offers only returnable lines, up to their returnable quantity", async () => {
      render(<OrderDetail initial={returnable} />);
      const { dialog } = await openDialog();
      const select = within(dialog).getByRole("combobox", {
        name: "How many Trail Runner to return",
      });
      expect(
        within(select)
          .getAllByRole("option")
          .map((o) => o.textContent),
      ).toEqual(["0", "1", "2"]);
      expect(
        within(dialog).queryByRole("combobox", { name: "How many Wool Sock to return" }),
      ).not.toBeInTheDocument();
      expect(within(dialog).getByRole("link", { name: "Returns policy" })).toHaveAttribute(
        "href",
        "/help/returns",
      );
    });

    it("asks for an item, then a reason, before sending", async () => {
      render(<OrderDetail initial={returnable} />);
      const { user, dialog } = await openDialog();
      await user.click(within(dialog).getByRole("button", { name: "Request return" }));
      expect(within(dialog).getByRole("alert")).toHaveTextContent(
        "Choose at least one item to return.",
      );
      await user.selectOptions(
        within(dialog).getByRole("combobox", { name: "How many Trail Runner to return" }),
        "1",
      );
      await user.click(within(dialog).getByRole("button", { name: "Request return" }));
      expect(within(dialog).getByRole("alert")).toHaveTextContent("Choose a reason.");
    });

    it("requests the return and shows it on the order", async () => {
      let sent: unknown;
      let url: URL | undefined;
      server.use(
        on("post", "/api/v1/orders/{number}/returns", async ({ request }) => {
          url = new URL(request.url);
          sent = await request.json();
          return HttpResponse.json(makeReturn({ rma_number: "RMA-0042" }), { status: 201 });
        }),
      );
      render(<OrderDetail initial={returnable} />);
      const { user, dialog } = await openDialog();
      await user.selectOptions(
        within(dialog).getByRole("combobox", { name: "How many Trail Runner to return" }),
        "1",
      );
      await user.selectOptions(within(dialog).getByLabelText("Reason"), "damaged");
      await user.type(
        within(dialog).getByLabelText("Anything we should know? (optional)"),
        "Sole split",
      );
      await user.click(within(dialog).getByRole("button", { name: "Request return" }));
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });
      expect(sent).toEqual({
        items: [{ order_item_id: "line-1", quantity: 1 }],
        reason: "damaged",
        note: "Sole split",
      });
      expect(url?.searchParams.get("token")).toBe("tok-1");
      expect(toast.success).toHaveBeenCalledWith(
        "Return RMA-0042 requested. We will email you next steps.",
      );
      expect(router.refresh).toHaveBeenCalled();
      expect(screen.getByRole("region", { name: "Returns" })).toHaveTextContent("RMA-0042");

      // One of the two units is now claimed.
      await user.click(screen.getByRole("button", { name: "Request a return" }));
      const again = await screen.findByRole("dialog", { name: "Return items" });
      expect(
        within(
          within(again).getByRole("combobox", { name: "How many Trail Runner to return" }),
        ).getAllByRole("option"),
      ).toHaveLength(2);
    });

    it("shows the first field error from the API", async () => {
      server.use(
        fail("post", "/api/v1/orders/{number}/returns", {
          status: 422,
          title: "Invalid",
          errors: [
            { field: "items", code: "invalid", message: "That item is outside the return window." },
          ],
        }),
      );
      render(<OrderDetail initial={makeOrder({ ...returnable, access_token: null })} />);
      const { user, dialog } = await openDialog();
      await user.selectOptions(
        within(dialog).getByRole("combobox", { name: "How many Trail Runner to return" }),
        "2",
      );
      await user.selectOptions(within(dialog).getByLabelText("Reason"), "other");
      await user.click(within(dialog).getByRole("button", { name: "Request return" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(
        "That item is outside the return window.",
      );
    });

    it("falls back to the problem detail, then the title", async () => {
      server.use(
        fail("post", "/api/v1/orders/{number}/returns", {
          status: 409,
          title: "Conflict",
          detail: "A return is already open.",
        }),
      );
      render(<OrderDetail initial={returnable} />);
      const { user, dialog } = await openDialog();
      await user.selectOptions(
        within(dialog).getByRole("combobox", { name: "How many Trail Runner to return" }),
        "1",
      );
      await user.selectOptions(within(dialog).getByLabelText("Reason"), "wrong_size");
      const submit = within(dialog).getByRole("button", { name: "Request return" });
      await user.click(submit);
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(
        "A return is already open.",
      );

      server.use(fail("post", "/api/v1/orders/{number}/returns", { status: 500, title: "Oops" }));
      await user.click(submit);
      await waitFor(() => {
        expect(within(dialog).getByRole("alert")).toHaveTextContent("Oops");
      });
    });

    it("closes with Not now", async () => {
      render(<OrderDetail initial={returnable} />);
      const { user, dialog } = await openDialog();
      await user.click(within(dialog).getByRole("button", { name: "Not now" }));
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });
    });
  });
});
