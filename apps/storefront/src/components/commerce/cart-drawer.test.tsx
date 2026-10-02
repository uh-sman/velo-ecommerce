import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { delay, HttpResponse } from "msw";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CartDrawer } from "@/components/commerce/cart-drawer";
import { announceCart, CART_CHANGED, openCart } from "@/components/commerce/cart-events";
import { cart, cartItem, totals, usd } from "@/test/fixtures/commerce";
import { setNavigation } from "@/test/navigation";
import { fail, ok, on, server } from "@/test/server";

afterEach(() => {
  vi.restoreAllMocks();
});

async function openDrawer(count = 1) {
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", {
      name: `Cart, ${String(count)} ${count === 1 ? "item" : "items"}`,
    }),
  );
  return { user, dialog: await screen.findByRole("dialog") };
}

describe("CartDrawer", () => {
  it("names the cart count on the trigger and caps the badge at 99+", () => {
    const view = render(<CartDrawer initialCount={0} />);
    expect(screen.getByRole("button", { name: "Cart, 0 items" })).toBeInTheDocument();
    view.rerender(<CartDrawer initialCount={120} />);
    const trigger = screen.getByRole("button", { name: "Cart, 120 items" });
    expect(trigger).toHaveTextContent("99+");
  });

  it("follows CART_CHANGED broadcasts", () => {
    render(<CartDrawer initialCount={1} />);
    act(() => {
      announceCart({ item_count: 3 });
    });
    expect(screen.getByRole("button", { name: "Cart, 3 items" })).toHaveTextContent("3");
  });

  it("opens on OPEN_CART, shows a skeleton, then the lines and subtotal", async () => {
    server.use(
      on("get", "/api/v1/cart", async () => {
        await delay(50);
        return HttpResponse.json(
          cart({
            items: [cartItem({ quantity: 2, line_total: usd(9000) })],
            totals: totals({ subtotal: usd(9000) }),
          }),
        );
      }),
    );
    render(<CartDrawer initialCount={0} />);
    act(() => {
      openCart();
    });
    const dialog = await screen.findByRole("dialog");
    expect(dialog.querySelector("[aria-busy]")).not.toBeNull();
    expect(
      await within(dialog).findByRole("heading", { name: "Your cart (2)" }),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Trail Tee" })).toHaveAttribute(
      "href",
      "/products/trail-tee",
    );
    expect(within(dialog).getByText("Medium")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Subtotal$90.00");
    expect(within(dialog).getByRole("link", { name: "Checkout" })).toHaveAttribute(
      "href",
      "/checkout",
    );
    expect(within(dialog).getByRole("link", { name: "View cart" })).toHaveAttribute(
      "href",
      "/cart",
    );
    // The trigger is hidden from assistive tech behind the modal, but kept in step.
    expect(screen.getByRole("button", { name: "Cart, 2 items", hidden: true })).toBeInTheDocument();
  });

  it("shows the empty state", async () => {
    server.use(ok("get", "/api/v1/cart", cart({ items: [] })));
    render(<CartDrawer initialCount={0} />);
    const { dialog } = await openDrawer(0);
    expect(await within(dialog).findByText("Your cart is empty")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Shop new arrivals" })).toHaveAttribute(
      "href",
      "/products",
    );
    expect(within(dialog).queryByRole("link", { name: "Checkout" })).not.toBeInTheDocument();
  });

  it("keeps the skeleton if the cart cannot be loaded", async () => {
    server.use(fail("get", "/api/v1/cart", { status: 500 }));
    render(<CartDrawer initialCount={2} />);
    const { dialog } = await openDrawer(2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dialog.querySelector("[aria-busy]")).not.toBeNull();
    expect(within(dialog).getByRole("heading", { name: "Your cart" })).toBeInTheDocument();
  });

  it("updates a quantity and broadcasts the new count", async () => {
    const changed = vi.fn();
    window.addEventListener(CART_CHANGED, changed);
    let sent: unknown;
    server.use(
      ok("get", "/api/v1/cart", cart()),
      on("patch", "/api/v1/cart/items/{item_id}", async ({ request, params }) => {
        sent = { id: params["item_id"], body: await request.json() };
        return HttpResponse.json(cart({ items: [cartItem({ quantity: 2 })] }));
      }),
    );
    render(<CartDrawer initialCount={1} />);
    const { user, dialog } = await openDrawer();
    await user.click(
      await within(dialog).findByRole("button", { name: "Increase quantity of Trail Tee Medium" }),
    );
    expect(
      await within(dialog).findByRole("heading", { name: "Your cart (2)" }),
    ).toBeInTheDocument();
    window.removeEventListener(CART_CHANGED, changed);
    expect(sent).toEqual({ id: "item-1", body: { quantity: 2 } });
    expect(changed).toHaveBeenCalled();
  });

  it("removes a line and confirms", async () => {
    const success = vi.spyOn(toast, "success");
    server.use(
      ok("get", "/api/v1/cart", cart()),
      ok("delete", "/api/v1/cart/items/{item_id}", cart({ items: [] })),
    );
    render(<CartDrawer initialCount={1} />);
    const { user, dialog } = await openDrawer();
    await user.click(
      await within(dialog).findByRole("button", { name: "Remove Trail Tee Medium from cart" }),
    );
    expect(await within(dialog).findByText("Your cart is empty")).toBeInTheDocument();
    expect(success).toHaveBeenCalledWith("Trail Tee removed", expect.anything());
    expect(screen.getByRole("button", { name: "Cart, 0 items", hidden: true })).toBeInTheDocument();
  });

  it("reports a refused change and reloads the server's cart", async () => {
    const error = vi.spyOn(toast, "error");
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
    render(<CartDrawer initialCount={1} />);
    const { user, dialog } = await openDrawer();
    await user.click(
      await within(dialog).findByRole("button", { name: "Increase quantity of Trail Tee Medium" }),
    );
    await waitFor(() => {
      expect(error).toHaveBeenCalledWith("Only 1 left", expect.anything());
    });
    await waitFor(() => {
      expect(loads).toBe(2);
    });
  });

  it("falls back to the problem title for a refused removal", async () => {
    const error = vi.spyOn(toast, "error");
    server.use(
      ok("get", "/api/v1/cart", cart()),
      fail("delete", "/api/v1/cart/items/{item_id}", { status: 409, title: "Cart is locked" }),
    );
    render(<CartDrawer initialCount={1} />);
    const { user, dialog } = await openDrawer();
    await user.click(
      await within(dialog).findByRole("button", { name: "Remove Trail Tee Medium from cart" }),
    );
    await waitFor(() => {
      expect(error).toHaveBeenCalledWith("Cart is locked", expect.anything());
    });
  });

  it("offers only Remove for a line that is no longer available", async () => {
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
    render(<CartDrawer initialCount={1} />);
    const { dialog } = await openDrawer();
    expect(await within(dialog).findByText("No longer available")).toBeInTheDocument();
    expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Remove Trail Tee Medium from cart" }),
    ).toBeInTheDocument();
  });

  it("closes on navigation", async () => {
    server.use(ok("get", "/api/v1/cart", cart()));
    const view = render(<CartDrawer initialCount={1} />);
    const { dialog } = await openDrawer();
    await within(dialog).findByRole("heading", { name: "Your cart (1)" });
    setNavigation({ pathname: "/checkout" });
    view.rerender(<CartDrawer initialCount={1} />);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});
