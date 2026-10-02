/**
 * Journey 6 — a return, end to end, across both apps.
 *
 * The customer buys (storefront), the warehouse ships and the carrier
 * delivers (arranged through the admin API: not part of this journey), the
 * customer requests a return from their account, and staff approve, receive
 * and refund it in the admin app. The customer then sees the refund.
 */

import { ADMIN_EMAIL, ADMIN_URL, DEMO_PASSWORD } from "../env";
import { productForSlot, registerCustomer, shipAndDeliver } from "../support/api";
import { expect, test } from "../support/fixtures";
import {
  addToCart,
  continueToPayment,
  expectConfirmation,
  goto,
  pay,
  signIn,
  submitContact,
  waitForSessionProbe,
} from "../support/storefront";

const HOME = {
  label: "Home",
  line1: "7 Return Road",
  city: "Austin",
  region: "TX",
  postal_code: "78701",
  country_code: "US",
};

test("a customer returns an item, staff refund it, and the customer sees the refund", async ({
  page,
  a11y,
  slot,
  tag,
  newAdminPage,
}) => {
  const product = await productForSlot(slot);
  const customer = await registerCustomer(tag, HOME);

  // ── The purchase ────────────────────────────────────────────────────────
  await signIn(page, a11y, customer.email, customer.password, "/account");
  await a11y.check(page, "account overview");
  await addToCart(page, a11y, product);
  await page
    .getByRole("dialog", { name: /Your cart/ })
    .getByRole("link", { name: "Checkout", exact: true })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Checkout" })).toBeVisible();
  await a11y.check(page, "checkout: contact step, signed in");
  await submitContact(page);
  await expect(
    page.getByRole("group", { name: "Shipping address" }).getByLabel("Address", { exact: true }),
  ).toHaveValue(HOME.line1);
  await a11y.check(page, "checkout: delivery step");
  await continueToPayment(page, a11y);
  await pay(page, "succeeds");
  const number = await expectConfirmation(page, a11y);

  await shipAndDeliver(number);

  // ── The customer asks for a return ──────────────────────────────────────
  await goto(page, `/account/orders/${number}`);
  await expect(page.getByRole("heading", { level: 1, name: `Order ${number}` })).toBeVisible();
  await a11y.check(page, "account: delivered order");
  await page.getByRole("button", { name: "Request a return" }).click();

  const dialog = page.getByRole("dialog", { name: "Return items" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(`How many ${product.title} to return`).selectOption("1");
  await dialog.getByLabel("Reason").selectOption({ label: "Wrong size or fit" });
  await dialog.getByLabel(/Anything we should know/).fill("Runs a size small.");
  await a11y.check(page, "account: return dialog");
  await dialog.getByRole("button", { name: "Request return" }).click();
  await expect(dialog).toBeHidden();

  const returns = page.getByRole("region", { name: "Returns" });
  await expect(returns).toBeVisible();
  const rma = /Return\s+([A-Z0-9][A-Z0-9-]{3,})/.exec(await returns.innerText())?.[1] ?? "";
  expect(rma, "an RMA number on the order page").not.toBe("");
  await expect(returns).toContainText("Requested");
  await a11y.check(page, "account: return requested");

  // ── Staff, in the admin app ─────────────────────────────────────────────
  const admin = await newAdminPage();
  const hydrated = waitForSessionProbe(admin);
  await admin.goto(`${ADMIN_URL}/sign-in?next=/returns`, { waitUntil: "domcontentloaded" });
  await hydrated;
  await expect(admin.getByRole("button", { name: "Sign in" })).toBeVisible();
  await a11y.check(admin, "admin: sign-in");
  await admin.getByLabel("Email").fill(ADMIN_EMAIL);
  await admin.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await admin.getByRole("button", { name: "Sign in" }).click();
  await expect(admin).toHaveURL(/\/returns/);
  await expect(admin.getByRole("heading", { level: 1, name: "Returns" })).toBeVisible();

  // (Toasts are list items too: the card is the one in the page's main content.)
  const card = admin.getByRole("main").getByRole("listitem").filter({ hasText: rma });
  await expect(card).toBeVisible();
  await expect(card).toContainText(number);
  await a11y.check(admin, "admin: returns queue");

  // Approve.
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card.getByRole("button", { name: "Receive…" })).toBeVisible();

  // Receive: inspect the item, put it back in stock.
  await card.getByRole("button", { name: "Receive…" }).click();
  const receive = admin.getByRole("dialog", { name: `Receive return ${rma}` });
  await expect(receive).toBeVisible();
  await expect(receive.getByText(product.title)).toBeVisible();
  await receive.getByLabel("Condition").selectOption("new");
  await receive.getByRole("checkbox", { name: /back in stock/ }).check();
  await a11y.check(admin, "admin: receive dialog");
  await receive.getByRole("button", { name: "Mark received" }).click();
  await expect(receive).toBeHidden();

  // Refund.
  await card.getByRole("button", { name: "Refund…" }).click();
  const refund = admin.getByRole("dialog", { name: /^Refund/ });
  await expect(refund).toBeVisible();
  await a11y.check(admin, "admin: refund confirmation");
  await refund.getByRole("button", { name: "Refund return" }).click();
  await expect(refund).toBeHidden();
  await expect(card).toContainText("Refunded");
  await expect(card).toContainText(/refunded \$[\d,]+\.\d{2}/);
  await a11y.check(admin, "admin: return refunded");

  // ── The customer sees the refund ────────────────────────────────────────
  await page.reload({ waitUntil: "domcontentloaded" });
  const after = page.getByRole("region", { name: "Returns" });
  await expect(after).toContainText(rma);
  await expect(after).toContainText("Refunded");
  await expect(after).toContainText(/Refund of \$[\d,]+\.\d{2} issued/);
  await expect(page.getByRole("list", { name: "Order progress" })).toContainText(/Refunded \$/);
  await a11y.check(page, "account: refund visible");
});
