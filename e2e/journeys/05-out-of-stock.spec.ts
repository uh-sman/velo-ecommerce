/**
 * Journey 5 — the item sells out between the cart and the checkout. Starting
 * checkout is refused with a message that says so, nothing is held or
 * charged, and the way back leads to a cart that marks the sold-out line.
 */

import { API_URL } from "../env";
import { productForSlot, setAvailableStock } from "../support/api";
import { expect, test } from "../support/fixtures";
import { addToCart, openCartPage, startCheckout, submitContact } from "../support/storefront";

test("an item that sells out mid-checkout is reported and the checkout does not start", async ({
  page,
  a11y,
  slot,
  tag,
}) => {
  const product = await productForSlot(slot);

  await addToCart(page, a11y, product);
  await openCartPage(page, a11y);

  // Which variant the page put in the cart: the cart says.
  const cart = (await (await page.request.get(`${API_URL}/api/v1/cart`)).json()) as {
    items: { variant: { id: string } }[];
  };
  const variantId = cart.items[0]?.variant.id;
  const variant = product.variants.find((candidate) => candidate.id === variantId);
  if (!variant) throw new Error("The cart does not hold this product's variant");

  await startCheckout(page, a11y);

  // Meanwhile, the last units sell elsewhere.
  await setAvailableStock(variant, 0);

  await submitContact(page, `sold-out-${tag}@example.com`);
  const alert = page.getByRole("alert").filter({
    hasText: "Some items sold out while you were shopping",
  });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("Update your cart and try again.");
  // The checkout did not start: still on step 1, with a way back to the cart.
  await expect(page.getByRole("button", { name: "Continue to delivery" })).toBeVisible();
  await a11y.check(page, "checkout: sold out");

  await page.getByRole("link", { name: "Review cart" }).click();
  await expect(page).toHaveURL(/\/cart$/);
  // The cart says which line sold out, on that line.
  const line = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name: product.title }) });
  await expect(line).toContainText("This is sold out.");
  await expect(line.getByRole("button", { name: /^Remove .* from cart$/ })).toBeVisible();
  await a11y.check(page, "cart: item sold out");
});
