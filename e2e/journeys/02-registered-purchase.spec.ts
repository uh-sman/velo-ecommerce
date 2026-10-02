/**
 * Journey 2 — a registered customer with an address book signs in, checks
 * out with their saved address, and finds the order in their account.
 */

import { productForSlot, registerCustomer } from "../support/api";
import { expect, test } from "../support/fixtures";
import {
  addToCart,
  continueToPayment,
  expectConfirmation,
  goto,
  pay,
  signIn,
  startCheckout,
  submitContact,
} from "../support/storefront";

const SAVED = {
  label: "Home",
  line1: "42 Galaxy Way",
  city: "Portland",
  region: "OR",
  postal_code: "97205",
  country_code: "US",
};

test("a signed-in customer pays with a saved address and sees the order in their account", async ({
  page,
  a11y,
  slot,
  tag,
}) => {
  const product = await productForSlot(slot);
  const customer = await registerCustomer(tag, SAVED);

  await signIn(page, a11y, customer.email, customer.password, "/account");
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await a11y.check(page, "account overview");

  await addToCart(page, a11y, product);
  await page
    .getByRole("dialog", { name: /Your cart/ })
    .getByRole("link", { name: "Checkout", exact: true })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Checkout" })).toBeVisible();
  await expect(page.getByText(`Signed in as ${customer.email}`)).toBeVisible();
  await a11y.check(page, "checkout: contact step, signed in");
  await submitContact(page);

  // The address book is offered, and the default address is already filled in.
  const saved = page.getByRole("group", { name: "Saved addresses" });
  await expect(saved.getByRole("button", { name: /Home/ })).toBeVisible();
  await saved.getByRole("button", { name: /Home/ }).click();
  const form = page.getByRole("group", { name: "Shipping address" });
  await expect(form.getByLabel("Address", { exact: true })).toHaveValue(SAVED.line1);
  await expect(form.getByLabel("Town or city")).toHaveValue(SAVED.city);
  await expect(form.getByLabel("ZIP code")).toHaveValue(SAVED.postal_code);
  await a11y.check(page, "checkout: delivery step with saved addresses");

  await continueToPayment(page, a11y);
  await expect(page.getByRole("region", { name: "Review your order" })).toContainText(SAVED.line1);
  await pay(page, "succeeds");
  const number = await expectConfirmation(page, a11y);

  // The order is in the account, and opens to its detail.
  await goto(page, "/account/orders");
  const entry = page.getByRole("listitem").filter({ hasText: number });
  await expect(entry).toBeVisible();
  await a11y.check(page, "account: orders");
  await entry.getByRole("link", { name: "View order" }).click();
  await expect(page.getByRole("heading", { level: 1, name: `Order ${number}` })).toBeVisible();
  await expect(page.getByText(SAVED.line1)).toBeVisible();
  await a11y.check(page, "account: order detail");
});
