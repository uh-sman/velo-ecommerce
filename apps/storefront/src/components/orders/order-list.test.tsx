import type { Schema } from "@velo/api-client";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CART_CHANGED, OPEN_CART } from "@/components/commerce/cart-events";
import { OrderList } from "@/components/orders/order-list";
import { makeLine, makeOrder, usd } from "@/test/fixtures/checkout-orders";
import { fail, ok, on, server } from "@/test/server";

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
vi.mock("@/components/ui/sonner", () => ({ notify: toast }));

function summary(overrides: Partial<Schema<"OrderSummaryView">> = {}) {
  return {
    number: "VLO-AAA111",
    status: "paid",
    placed_at: "2026-09-01T10:00:00Z",
    item_count: 2,
    total: usd(9500),
    payment_status: "captured",
    fulfilment_status: "unfulfilled",
    ...overrides,
  } satisfies Schema<"OrderSummaryView">;
}

function page(data: Schema<"OrderSummaryView">[], next: string | null = null) {
  return { data, pagination: { next_cursor: next, has_more: next !== null } };
}

const cart = {
  id: "cart-1",
  currency: "USD",
  discount: null,
  discount_code: null,
  discounts: [],
  item_count: 3,
  items: [],
  shipping: null,
  warnings: [],
  totals: {
    subtotal: usd(0),
    discount: usd(0),
    shipping: null,
    tax: null,
    tax_included: null,
    total: usd(0),
  },
} satisfies Schema<"CartView">;

describe("OrderList", () => {
  beforeEach(() => {
    for (const fn of Object.values(toast)) fn.mockReset();
  });

  it("shows a loading state, then each order with its status and total", async () => {
    server.use(
      on("get", "/api/v1/orders", () =>
        HttpResponse.json(
          page([summary(), summary({ number: "VLO-BBB222", item_count: 1, status: "delivered" })]),
        ),
      ),
    );
    const { container } = render(<OrderList />);
    expect(container.querySelector("[aria-busy]")).not.toBeNull();
    expect(await screen.findByText("VLO-AAA111")).toBeInTheDocument();
    expect(screen.getByText("Confirmed")).toBeInTheDocument();
    expect(screen.getByText("Delivered")).toBeInTheDocument();
    expect(screen.getByText(/2 items · \$95\.00/)).toBeInTheDocument();
    expect(screen.getByText(/1 item · \$95\.00/)).toBeInTheDocument();
    const links = screen.getAllByRole("link", { name: "View order" });
    expect(links[1]).toHaveAttribute("href", "/account/orders/VLO-BBB222");
    expect(screen.queryByRole("button", { name: "Older orders" })).not.toBeInTheDocument();
  });

  it("invites a customer with no orders to start shopping", async () => {
    server.use(on("get", "/api/v1/orders", () => HttpResponse.json(page([]))));
    render(<OrderList />);
    expect(await screen.findByText("No orders yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start shopping" })).toHaveAttribute(
      "href",
      "/products",
    );
  });

  it("offers a retry when the first page fails", async () => {
    server.use(fail("get", "/api/v1/orders", { status: 500 }));
    render(<OrderList />);
    expect(await screen.findByRole("alert")).toHaveTextContent("We could not load your orders");
    server.use(on("get", "/api/v1/orders", () => HttpResponse.json(page([summary()]))));
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("VLO-AAA111")).toBeInTheDocument();
  });

  it("loads older orders with the cursor and appends them", async () => {
    const cursors: (string | null)[] = [];
    server.use(
      on("get", "/api/v1/orders", ({ request }) => {
        const url = new URL(request.url);
        const cursor = url.searchParams.get("cursor");
        cursors.push(cursor);
        expect(url.searchParams.get("limit")).toBe("10");
        return HttpResponse.json(
          cursor ? page([summary({ number: "VLO-OLD999" })]) : page([summary()], "c2"),
        );
      }),
    );
    render(<OrderList />);
    const older = await screen.findByRole("button", { name: "Older orders" });
    await userEvent.setup().click(older);
    expect(await screen.findByText("VLO-OLD999")).toBeInTheDocument();
    expect(screen.getByText("VLO-AAA111")).toBeInTheDocument();
    expect(cursors).toEqual([null, "c2"]);
    expect(screen.queryByRole("button", { name: "Older orders" })).not.toBeInTheDocument();
  });

  it("keeps the loaded orders if a later page fails", async () => {
    server.use(
      on("get", "/api/v1/orders", ({ request }) =>
        new URL(request.url).searchParams.get("cursor")
          ? HttpResponse.json({ type: "x", title: "x", status: 500 }, { status: 500 })
          : HttpResponse.json(page([summary()], "c2")),
      ),
    );
    render(<OrderList />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Older orders" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Older orders" })).toBeEnabled();
    });
    expect(screen.getByText("VLO-AAA111")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  describe("Buy again", () => {
    beforeEach(() => {
      server.use(on("get", "/api/v1/orders", () => HttpResponse.json(page([summary()]))));
    });

    let events: string[] = [];
    const record = (event: Event) => {
      events.push(event.type);
    };
    beforeEach(() => {
      events = [];
      window.addEventListener(CART_CHANGED, record);
      window.addEventListener(OPEN_CART, record);
    });
    afterEach(() => {
      window.removeEventListener(CART_CHANGED, record);
      window.removeEventListener(OPEN_CART, record);
    });

    async function buyAgain() {
      await userEvent.setup().click(await screen.findByRole("button", { name: "Buy again" }));
    }

    it("adds every line back to the cart and opens it", async () => {
      const added: unknown[] = [];
      server.use(
        ok(
          "get",
          "/api/v1/orders/{number}",
          makeOrder({
            lines: [makeLine(), makeLine({ id: "line-2", variant_id: "var-2", quantity: 1 })],
          }),
        ),
        on("post", "/api/v1/cart/items", async ({ request }) => {
          added.push(await request.json());
          return HttpResponse.json(cart);
        }),
      );
      render(<OrderList />);
      await buyAgain();
      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith("Everything is back in your cart.");
      });
      expect(added).toEqual([
        { variant_id: "var-1", quantity: 2 },
        { variant_id: "var-2", quantity: 1 },
      ]);
      expect(events).toEqual([CART_CHANGED, OPEN_CART]);
    });

    it("names the lines that could not be re-added", async () => {
      server.use(
        ok(
          "get",
          "/api/v1/orders/{number}",
          makeOrder({
            lines: [
              makeLine(),
              makeLine({ id: "line-2", variant_id: null, product_title: "Old Cap" }),
              makeLine({ id: "line-3", variant_id: "var-3", product_title: "Sold Out Sock" }),
            ],
          }),
        ),
        on("post", "/api/v1/cart/items", async ({ request }) => {
          const body = (await request.json()) as { variant_id: string };
          return body.variant_id === "var-1"
            ? HttpResponse.json(cart)
            : HttpResponse.json({ type: "x", title: "x", status: 409 }, { status: 409 });
        }),
      );
      render(<OrderList />);
      await buyAgain();
      await waitFor(() => {
        expect(toast.warning).toHaveBeenCalledWith(
          "Added to your cart — except Old Cap, Sold Out Sock, no longer available.",
        );
      });
      expect(events).toEqual([CART_CHANGED, OPEN_CART]);
    });

    it("says so when nothing can be bought any more", async () => {
      server.use(
        ok(
          "get",
          "/api/v1/orders/{number}",
          makeOrder({ lines: [makeLine({ variant_id: null })] }),
        ),
      );
      render(<OrderList />);
      await buyAgain();
      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith("None of these items can be bought any more.");
      });
      expect(events).toEqual([]);
    });

    it("reports a failure to read the order", async () => {
      server.use(fail("get", "/api/v1/orders/{number}", { status: 500 }));
      render(<OrderList />);
      await buyAgain();
      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith("We could not read that order. Please try again.");
      });
    });
  });
});
