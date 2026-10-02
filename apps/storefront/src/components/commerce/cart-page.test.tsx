import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { delay, HttpResponse } from "msw";
import type { MouseEvent } from "react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { CartPage } from "@/components/commerce/cart-page";
import { CART_CHANGED } from "@/components/commerce/cart-events";
import { cart, cartItem, totals, usd } from "@/test/fixtures/commerce";
import { fail, ok, on, server } from "@/test/server";

afterEach(() => {
  vi.restoreAllMocks();
});

/** The "Undo" action of the last success toast, as sonner would invoke it. */
function lastUndo(spy: MockInstance<typeof toast.success>): () => void {
  const action = spy.mock.calls.at(-1)?.[1]?.action;
  if (!action || typeof action !== "object" || !("onClick" in action)) {
    throw new Error("no toast action");
  }
  expect(action.label).toBe("Undo");
  return () => {
    action.onClick(new window.MouseEvent("click") as unknown as MouseEvent<HTMLButtonElement>);
  };
}

const twoLines = () =>
  cart({
    items: [
      cartItem({ quantity: 2, line_total: usd(9000), line_discount: usd(500) }),
      cartItem({
        id: "item-2",
        quantity: 1,
        line_total: usd(2000),
        unit_price: usd(2000),
        variant: { id: "var-2", product_title: "Ridge Cap", variant_title: "One size" },
      }),
    ],
    totals: totals({ subtotal: usd(11000), discount: usd(500), total: usd(10500) }),
  });

describe("CartPage", () => {
  it("shows a skeleton while the cart loads", async () => {
    server.use(
      on("get", "/api/v1/cart", async () => {
        await delay(50);
        return HttpResponse.json(cart());
      }),
    );
    const { container } = render(<CartPage />);
    expect(container.querySelector("[aria-busy]")).not.toBeNull();
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(
      "Your cart (1 item)",
    );
  });

  it("offers a retry when the cart cannot be loaded", async () => {
    server.use(fail("get", "/api/v1/cart", { status: 500 }));
    render(<CartPage />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("We could not load your cart");
    server.use(ok("get", "/api/v1/cart", cart()));
    await userEvent.setup().click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Your cart");
  });

  it("shows the empty state with ways back to the shop", async () => {
    server.use(ok("get", "/api/v1/cart", cart({ items: [] })));
    render(<CartPage />);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Your cart is empty" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Shop new arrivals" })).toHaveAttribute(
      "href",
      "/products",
    );
    expect(screen.getByRole("link", { name: "View collections" })).toHaveAttribute(
      "href",
      "/collections",
    );
  });

  it("renders lines, warnings, unit prices, discounts and the summary", async () => {
    server.use(
      ok(
        "get",
        "/api/v1/cart",
        cart({
          ...twoLines(),
          warnings: [
            { code: "discount_not_applied", message: "SPRING10 needs a $100 order" },
            { code: "price_changed", message: "Price went up", item_id: "item-1" },
          ],
        }),
      ),
    );
    render(<CartPage />);
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(
      "Your cart (3 items)",
    );
    expect(screen.getByRole("status")).toHaveTextContent("SPRING10 needs a $100 order");
    expect(screen.getByText("Price went up")).toBeInTheDocument();
    expect(screen.getByText("$45.00 each")).toBeInTheDocument();
    // Once on the line, once as the aggregate discount in the summary.
    expect(screen.getAllByText("−$5.00")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Ridge Cap" })).toHaveAttribute(
      "href",
      "/products/trail-tee",
    );
    expect(screen.getByRole("region", { name: "Order summary" })).toHaveTextContent("$105.00");
    expect(screen.getAllByRole("link", { name: "Checkout" })).toHaveLength(2);
    expect(screen.getByText("Total $105.00")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "No longer available" })).not.toBeInTheDocument();
  });

  it("separates lines that are no longer available and hides checkout if nothing is", async () => {
    server.use(
      ok(
        "get",
        "/api/v1/cart",
        cart({
          items: [
            cartItem({
              purchasable: false,
              availability: { in_stock: false, max_quantity: 0 },
              variant: { image_url: null },
            }),
          ],
        }),
      ),
    );
    render(<CartPage />);
    const section = await screen.findByRole("region", { name: "No longer available" });
    expect(within(section).queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      within(section).getByRole("button", { name: "Remove Trail Tee Medium from cart" }),
    ).toBeInTheDocument();
    // The summary's Checkout is visually hidden; the mobile bar drops its own.
    expect(screen.getAllByRole("link", { name: "Checkout" })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Checkout" })).toHaveClass("hidden");
  });

  it("updates a quantity, re-renders the server's cart and announces the total", async () => {
    const changed = vi.fn();
    window.addEventListener(CART_CHANGED, changed);
    let sent: unknown;
    server.use(
      ok("get", "/api/v1/cart", cart()),
      on("patch", "/api/v1/cart/items/{item_id}", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(
          cart({
            items: [cartItem({ quantity: 2, line_total: usd(9000) })],
            totals: totals({ subtotal: usd(9000), total: usd(9000) }),
          }),
        );
      }),
    );
    render(<CartPage />);
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Increase quantity of Trail Tee Medium" }));
    expect(await screen.findByText("Quantity updated. Cart total $90.00.")).toBeInTheDocument();
    window.removeEventListener(CART_CHANGED, changed);
    expect(sent).toEqual({ quantity: 2 });
    expect(changed).toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your cart (2 items)");
  });

  it("shows a refused quantity on its line, refetches, and clears it on success", async () => {
    let loads = 0;
    server.use(
      on("get", "/api/v1/cart", () => {
        loads += 1;
        return HttpResponse.json(cart());
      }),
      fail("patch", "/api/v1/cart/items/{item_id}", {
        status: 422,
        errors: [{ field: "quantity", code: "insufficient_stock", message: "Only 1 left" }],
      }),
    );
    render(<CartPage />);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Increase quantity of Trail Tee Medium" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Only 1 left");
    await waitFor(() => {
      expect(loads).toBe(2);
    });

    server.use(ok("patch", "/api/v1/cart/items/{item_id}", cart({ items: [cartItem()] })));
    await user.click(screen.getByRole("button", { name: "Increase quantity of Trail Tee Medium" }));
    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  it("uses the problem detail, then the title, when there is no field error", async () => {
    server.use(
      ok("get", "/api/v1/cart", twoLines()),
      fail("delete", "/api/v1/cart/items/{item_id}", {
        status: 409,
        title: "Conflict",
        detail: "The cart changed in another tab.",
      }),
    );
    render(<CartPage />);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Remove Trail Tee Medium from cart" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("The cart changed in another tab.");

    server.use(fail("delete", "/api/v1/cart/items/{item_id}", { status: 503, title: "Busy" }));
    await user.click(screen.getByRole("button", { name: "Remove Ridge Cap One size from cart" }));
    await waitFor(() => {
      expect(screen.getAllByRole("alert")).toHaveLength(2);
    });
    expect(screen.getAllByRole("alert")[1]).toHaveTextContent("Busy");
  });

  it("removes a line with a five-second Undo that restores it", async () => {
    const success = vi.spyOn(toast, "success");
    let restored: unknown;
    server.use(
      ok("get", "/api/v1/cart", twoLines()),
      ok("delete", "/api/v1/cart/items/{item_id}", cart()),
      on("post", "/api/v1/cart/items", async ({ request }) => {
        restored = await request.json();
        return HttpResponse.json(twoLines());
      }),
    );
    render(<CartPage />);
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Remove Ridge Cap One size from cart" }));
    expect(await screen.findByText(/^Ridge Cap removed\. Cart total/)).toBeInTheDocument();
    expect(success).toHaveBeenCalledWith(
      "Ridge Cap removed",
      expect.objectContaining({ duration: 4000 }),
    );

    lastUndo(success)();
    expect(await screen.findByText("Item restored. Cart total $105.00.")).toBeInTheDocument();
    expect(restored).toEqual({ variant_id: "var-2", quantity: 1 });
  });

  it("toasts a failed Undo, which belongs to no line", async () => {
    const success = vi.spyOn(toast, "success");
    const error = vi.spyOn(toast, "error");
    server.use(
      ok("get", "/api/v1/cart", twoLines()),
      ok("delete", "/api/v1/cart/items/{item_id}", cart()),
      fail("post", "/api/v1/cart/items", { status: 409, title: "Sold out" }),
    );
    render(<CartPage />);
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Remove Ridge Cap One size from cart" }));
    await waitFor(() => {
      expect(success).toHaveBeenCalled();
    });
    lastUndo(success)();
    await waitFor(() => {
      expect(error).toHaveBeenCalledWith("Sold out", expect.anything());
    });
  });

  it("removes an applied discount code", async () => {
    let removed = false;
    server.use(
      ok(
        "get",
        "/api/v1/cart",
        cart({
          discount_code: "SPRING10",
          discounts: [{ code: "SPRING10", title: "Spring", type: "percentage", amount: usd(450) }],
        }),
      ),
      on("delete", "/api/v1/cart/discount", () => {
        removed = true;
        return HttpResponse.json(cart());
      }),
    );
    render(<CartPage />);
    expect(await screen.findByLabelText("Discount code (SPRING10 entered)")).toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Remove discount code SPRING10" }));
    expect(await screen.findByText("Discount removed. Cart total $45.00.")).toBeInTheDocument();
    expect(removed).toBe(true);
    expect(screen.getByLabelText("Discount code")).toBeInTheDocument();
  });

  it("toasts a failed code removal", async () => {
    const error = vi.spyOn(toast, "error");
    server.use(
      ok(
        "get",
        "/api/v1/cart",
        cart({
          discount_code: "SPRING10",
          discounts: [{ code: "SPRING10", title: "Spring", type: "percentage", amount: usd(450) }],
        }),
      ),
      fail("delete", "/api/v1/cart/discount", { status: 500, title: "Oops", detail: "Retry." }),
    );
    render(<CartPage />);
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Remove discount code SPRING10" }));
    await waitFor(() => {
      expect(error).toHaveBeenCalledWith("Retry.", expect.anything());
    });
  });
});

describe("CartPage discount form", () => {
  it("asks for a code before sending anything", async () => {
    server.use(ok("get", "/api/v1/cart", cart()));
    render(<CartPage />);
    const field = await screen.findByLabelText("Discount code");
    await userEvent.setup().click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByText("Enter a discount code.")).toBeInTheDocument();
    expect(field).toHaveFocus();
    expect(field).toHaveAttribute("aria-invalid", "true");
  });

  it("applies a trimmed code and shows the re-priced cart", async () => {
    const success = vi.spyOn(toast, "success");
    let sent: unknown;
    server.use(
      ok("get", "/api/v1/cart", cart()),
      on("post", "/api/v1/cart/discount", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(
          cart({
            discount_code: "SPRING10",
            discounts: [
              { code: "SPRING10", title: "Spring", type: "percentage", amount: usd(450) },
            ],
            totals: totals({ discount: usd(450), total: usd(4050) }),
          }),
        );
      }),
    );
    render(<CartPage />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Discount code"), "  SPRING10 ");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("Discount applied. Cart total $40.50.")).toBeInTheDocument();
    expect(sent).toEqual({ code: "SPRING10" });
    expect(success).toHaveBeenCalledWith("Discount applied", expect.anything());
    expect(screen.getByLabelText("Discount code (SPRING10 entered)")).toHaveValue("");
  });

  it("shows why a code was refused, from the field error or the detail", async () => {
    server.use(
      ok("get", "/api/v1/cart", cart()),
      fail("post", "/api/v1/cart/discount", {
        status: 422,
        errors: [{ field: "code", code: "expired", message: "This code has expired." }],
      }),
    );
    render(<CartPage />);
    const user = userEvent.setup();
    const field = await screen.findByLabelText("Discount code");
    await user.type(field, "OLD");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("This code has expired.")).toBeInTheDocument();
    expect(field).toHaveFocus();

    server.use(
      fail("post", "/api/v1/cart/discount", {
        status: 404,
        title: "Not found",
        detail: "No such code.",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("No such code.")).toBeInTheDocument();
  });
});
