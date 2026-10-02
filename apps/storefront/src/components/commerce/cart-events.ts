/** Broadcast after any cart change, so the header count stays in step. */
export const CART_CHANGED = "velo:cart-changed";
/** Ask the cart drawer to open — after an add to cart, say. */
export const OPEN_CART = "velo:open-cart";

export function announceCart(cart: { item_count: number }): void {
  window.dispatchEvent(new CustomEvent(CART_CHANGED, { detail: cart.item_count }));
}

export function openCart(): void {
  window.dispatchEvent(new Event(OPEN_CART));
}
