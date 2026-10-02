import { describe, expect, it, vi } from "vitest";

import { announceCart, CART_CHANGED, OPEN_CART, openCart } from "@/components/commerce/cart-events";

describe("cart events", () => {
  it("broadcasts the new item count on CART_CHANGED", () => {
    const listener = vi.fn();
    window.addEventListener(CART_CHANGED, listener);
    announceCart({ item_count: 3 });
    window.removeEventListener(CART_CHANGED, listener);

    expect(listener).toHaveBeenCalledTimes(1);
    const event: unknown = listener.mock.calls[0]?.[0];
    expect(event).toBeInstanceOf(CustomEvent);
    expect((event as CustomEvent<number>).detail).toBe(3);
  });

  it("asks the drawer to open with OPEN_CART", () => {
    const listener = vi.fn();
    window.addEventListener(OPEN_CART, listener);
    openCart();
    window.removeEventListener(OPEN_CART, listener);

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
