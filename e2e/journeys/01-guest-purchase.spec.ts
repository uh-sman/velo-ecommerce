/**
 * Journey 1 — a guest buys something, start to finish: product page, cart,
 * the four checkout steps, the sandbox card, and the confirmation page with
 * the order the worker created. Then the order is found again by its signed
 * link, the way a guest gets back to it.
 */

import { productForSlot } from "../support/api";
import { expect, test } from "../support/fixtures";
import {
  addToCart,
  continueToPayment,
  expectConfirmation,
  expectDeliveryStep,
  fillShippingAddress,
  openCartPage,
  pay,
  startCheckout,
  submitContact,
} from "../support/storefront";

test("a guest buys a product and gets an order number", async ({ page, a11y, slot, tag }) => {
  const product = await productForSlot(slot);
  const email = `guest-${tag}-${Date.now().toString(36)}@example.com`;

  await addToCart(page, a11y, product);
  await openCartPage(page, a11y);
  await expect(page.getByRole("link", { name: product.title })).toBeVisible();

  await startCheckout(page, a11y);
  await submitContact(page, email);

  await expectDeliveryStep(page, a11y);
  await fillShippingAddress(page);
  await continueToPayment(page, a11y);

  // The review restates who, where and how much before the customer pays.
  const review = page.getByRole("region", { name: "Review your order" });
  await expect(review).toContainText(email);
  await expect(review).toContainText("1 Market Street");

  await pay(page, "succeeds");
  const number = await expectConfirmation(page, a11y);

  // "Track this order" opens the order with its signed link — no account needed.
  const track = page.getByRole("link", { name: "Track this order" });
  await expect(track).toHaveAttribute("href", new RegExp(`/orders/${number}\\?token=`));
  await track.click();
  await expect(page.getByRole("heading", { level: 1, name: `Order ${number}` })).toBeVisible();
  await expect(page.getByText(product.title).first()).toBeVisible();
  await a11y.check(page, "guest order page");
});
