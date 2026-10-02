/**
 * Journey 3 — a discount code entered on the way to checkout: the summary
 * shows the code's own line, the total drops by exactly that much, the
 * amount on the Pay button is the discounted total, and the order keeps it.
 */

import { createPercentageCode, productForSlot } from "../support/api";
import { expect, test } from "../support/fixtures";
import {
  addToCart,
  cents,
  continueToPayment,
  expectConfirmation,
  expectDeliveryStep,
  fillShippingAddress,
  openCartPage,
  pay,
  submitContact,
} from "../support/storefront";

test("a discount code is applied and the total reflects it through to the order", async ({
  page,
  a11y,
  slot,
  tag,
}) => {
  const product = await productForSlot(slot);
  const code =
    `E2E${tag.replace(/[^a-z0-9]/gi, "").toUpperCase()}${Date.now().toString(36).toUpperCase()}`.slice(
      0,
      32,
    );
  await createPercentageCode(code, 10);

  await addToCart(page, a11y, product);
  await openCartPage(page, a11y);

  // A wrong code is refused, inline.
  const field = page.getByLabel("Discount code");
  await field.fill("NOT-A-REAL-CODE");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(field).toHaveAccessibleDescription(/\w+/);
  await a11y.check(page, "cart: invalid discount code");

  await page.getByLabel("Discount code").fill(code);
  await page.getByRole("button", { name: "Apply" }).click();
  const summary = page.getByRole("region", { name: "Order summary" });
  await expect(summary.getByText(`Discount (${code})`)).toBeVisible();
  await a11y.check(page, "cart: discount applied");

  await page.getByRole("link", { name: "Checkout", exact: true }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Checkout" })).toBeVisible();
  await a11y.check(page, "checkout: contact step");
  await submitContact(page, `discount-${tag}@example.com`);
  await expectDeliveryStep(page, a11y);
  await fillShippingAddress(page);
  await continueToPayment(page, a11y);

  // The checkout's summary: subtotal − 10% + shipping + tax = total = the Pay button.
  const checkoutSummary = page.getByRole("region", { name: "Order summary" });
  const amount = async (label: string | RegExp) =>
    cents(
      await checkoutSummary
        .locator("dt", { hasText: label })
        .locator("xpath=following-sibling::dd[1]")
        .innerText(),
    );
  const subtotal = await amount(/^Subtotal/);
  const discount = await amount(`Discount (${code})`);
  const shipping = await amount(/^Shipping/);
  const tax = await amount(/^Tax/);
  const total = await amount(/^Total$/);

  expect(discount).toBe(Math.round(subtotal * 0.1));
  expect(total).toBe(subtotal - discount + shipping + tax);
  const payLabel = await pay(page, "succeeds");
  expect(cents(payLabel)).toBe(total);

  await expectConfirmation(page, a11y);
  const confirmed = page.getByRole("region", { name: "Order summary" });
  await expect(confirmed.getByText(`Discount (${code})`)).toBeVisible();
  await expect(confirmed.locator("dd").last()).toHaveText(
    `$${(total / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
  );
});
