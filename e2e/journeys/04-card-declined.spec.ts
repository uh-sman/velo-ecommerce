/**
 * Journey 4 — the bank declines the first card. The customer is told so on
 * the page (not charged, items still held), picks another card on the same
 * form, and the second attempt goes through to an order.
 */

import { productForSlot } from "../support/api";
import { expect, test } from "../support/fixtures";
import {
  addToCart,
  continueToPayment,
  expectConfirmation,
  expectDeliveryStep,
  fillShippingAddress,
  pay,
  submitContact,
} from "../support/storefront";

test("a declined card can be retried with another and the order goes through", async ({
  page,
  a11y,
  slot,
  tag,
}) => {
  const product = await productForSlot(slot);

  await addToCart(page, a11y, product);
  await page
    .getByRole("dialog", { name: /Your cart/ })
    .getByRole("link", { name: "Checkout", exact: true })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Checkout" })).toBeVisible();
  await a11y.check(page, "checkout: contact step");
  await submitContact(page, `declined-${tag}@example.com`);
  await expectDeliveryStep(page, a11y);
  await fillShippingAddress(page);
  await continueToPayment(page, a11y);

  // First attempt: the decline card.
  const firstLabel = await pay(page, "declined");
  const alert = page.getByRole("alert").filter({ hasText: "Payment not completed" });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("Your card was declined.");
  await expect(page).toHaveURL(/\/checkout$/);
  await a11y.check(page, "checkout: card declined");

  // Second attempt on the same form, same amount: the good card.
  const secondLabel = await pay(page, "succeeds");
  expect(secondLabel).toBe(firstLabel);
  await expectConfirmation(page, a11y);
});
