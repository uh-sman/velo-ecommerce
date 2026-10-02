/**
 * The storefront steps the journeys share, written as a customer would do
 * them: by role and label, through the UI. Each step runs axe on the state it
 * leaves the page in.
 */

import { expect, type Page } from "@playwright/test";

import { STOREFRONT_URL } from "../env";
import type { A11yAudit } from "./a11y";
import type { Product } from "./api";

export const SHIPPING_ADDRESS = {
  first_name: "Grace",
  last_name: "Hopper",
  line1: "1 Market Street",
  city: "San Francisco",
  region: "CA",
  postal_code: "94105",
  country_code: "US",
};

/** "$1,234.56" (or "−$12.00") → cents. */
export function cents(text: string): number {
  const match = /([\d,]+)\.(\d{2})/.exec(text);
  if (!match?.[1] || !match[2]) throw new Error(`No amount in "${text}"`);
  return Number(match[1].replace(/,/g, "")) * 100 + Number(match[2]);
}

export async function goto(page: Page, path: string): Promise<void> {
  // Product images come from a third-party host; the page is usable before they load.
  await page.goto(`${STOREFRONT_URL}${path}`, { waitUntil: "domcontentloaded" });
}

/** Open the product page and add its default variant to the cart. */
export async function addToCart(page: Page, a11y: A11yAudit, product: Product): Promise<void> {
  await goto(page, `/products/${product.slug}`);
  await expect(page.getByRole("heading", { level: 1, name: product.title })).toBeVisible();
  await a11y.check(page, "product page");
  await page.getByRole("button", { name: "Add to cart" }).first().click();
  // The drawer opens with the line in it.
  const drawer = page.getByRole("dialog", { name: /Your cart/ });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("link", { name: product.title })).toBeVisible();
  await a11y.check(page, "cart drawer open");
}

/** From the open cart drawer to the cart page. */
export async function openCartPage(page: Page, a11y: A11yAudit): Promise<void> {
  await page
    .getByRole("dialog", { name: /Your cart/ })
    .getByRole("link", { name: "View cart" })
    .click();
  await expect(page).toHaveURL(/\/cart$/);
  await expect(page.getByRole("heading", { level: 1, name: /Your cart/ })).toBeVisible();
  await a11y.check(page, "cart page");
}

/** From the cart page (or drawer) into checkout. */
export async function startCheckout(page: Page, a11y: A11yAudit): Promise<void> {
  await page.getByRole("link", { name: "Checkout", exact: true }).first().click();
  await expect(page).toHaveURL(/\/checkout$/);
  await expect(page.getByRole("heading", { level: 1, name: "Checkout" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue to delivery" })).toBeVisible();
  await a11y.check(page, "checkout: contact step");
}

export async function submitContact(page: Page, email?: string): Promise<void> {
  if (email) await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Continue to delivery" }).click();
}

export async function fillShippingAddress(page: Page): Promise<void> {
  const form = page.getByRole("group", { name: "Shipping address" });
  await form.getByLabel("Country").selectOption(SHIPPING_ADDRESS.country_code);
  await form.getByLabel("First name").fill(SHIPPING_ADDRESS.first_name);
  await form.getByLabel("Last name").fill(SHIPPING_ADDRESS.last_name);
  await form.getByLabel("Address", { exact: true }).fill(SHIPPING_ADDRESS.line1);
  await form.getByLabel("Town or city").fill(SHIPPING_ADDRESS.city);
  await form.getByLabel("State").fill(SHIPPING_ADDRESS.region);
  await form.getByLabel("ZIP code").fill(SHIPPING_ADDRESS.postal_code);
}

export async function expectDeliveryStep(page: Page, a11y: A11yAudit): Promise<void> {
  await expect(page.getByRole("button", { name: "Continue to shipping" })).toBeVisible();
  await a11y.check(page, "checkout: delivery step");
}

/** Delivery → shipping → payment: accept the default rate and reach the sandbox form. */
export async function continueToPayment(page: Page, a11y: A11yAudit): Promise<void> {
  await page.getByRole("button", { name: "Continue to shipping" }).click();
  const toPayment = page.getByRole("button", { name: "Continue to payment" });
  await expect(toPayment).toBeVisible();
  await expect(page.getByRole("radio").first()).toBeChecked();
  await a11y.check(page, "checkout: shipping step");
  await toPayment.click();

  await page.getByRole("button", { name: "Continue to secure payment" }).click();
  await expect(page.getByRole("group", { name: "Sandbox payment — no real money" })).toBeVisible();
  await a11y.check(page, "checkout: payment step");
}

export type Card = "succeeds" | "declined";

/** Choose a sandbox test card and press Pay; returns the amount on the button. */
export async function pay(page: Page, card: Card): Promise<string> {
  const form = page.getByRole("group", { name: "Sandbox payment — no real money" });
  await form
    .getByRole("radio", {
      name:
        card === "succeeds"
          ? "Test card 4242 4242 4242 4242 — succeeds"
          : "Test card 4000 0000 0000 0002 — declined",
    })
    .check();
  const button = page.getByRole("button", { name: /^Pay \$/ });
  const label = (await button.textContent()) ?? "";
  await button.click();
  return label;
}

/** The confirmation page, once the worker has made the order; returns its number. */
export async function expectConfirmation(page: Page, a11y: A11yAudit): Promise<string> {
  await expect(page).toHaveURL(/\/checkout\/confirmation\?checkout=/);
  const heading = page.getByRole("heading", { level: 1, name: /^Order confirmed/ });
  await expect(heading).toBeVisible({ timeout: 60_000 });
  const status = page.getByRole("status").filter({ has: heading });
  const text = await status.innerText();
  const number = /Order\s+([A-Z0-9][A-Z0-9-]{3,})/.exec(text)?.[1] ?? "";
  expect(number, `an order number in "${text}"`).not.toBe("");
  await a11y.check(page, "order confirmation");
  return number;
}

/** Sign in on the storefront's own form. */
export async function signIn(
  page: Page,
  a11y: A11yAudit,
  email: string,
  password: string,
  next = "/account",
): Promise<void> {
  // The form tries a silent refresh once it is hydrated; typing before that
  // would fill inputs React does not know about yet.
  const hydrated = waitForSessionProbe(page);
  await goto(page, `/sign-in?next=${encodeURIComponent(next)}`);
  await hydrated;
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await a11y.check(page, "sign-in page");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
}

/** Resolves when a sign-in form has mounted: it probes for a session on mount. */
export function waitForSessionProbe(page: Page): Promise<unknown> {
  return page.waitForResponse((response) => response.url().includes("/api/v1/auth/refresh"));
}
