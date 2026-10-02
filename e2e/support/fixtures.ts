/**
 * The suite's `test`: Playwright's, plus
 *
 * - `a11y` — axe checks, and a guard that every visited page was checked;
 * - `slot` — a number unique to this journey and browser, so tests running
 *   side by side pick different products and codes;
 * - `newAdminPage` — a page in a separate browser context for the admin app:
 *   the storefront and the admin share the `localhost` cookie domain, so a
 *   customer and a member of staff need separate cookie jars;
 * - rate-limit counters reset before every test (see support/redis.ts);
 * - on WebKit, Next.js link prefetches are refused (see `withoutPrefetch`).
 */

import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";

import { A11yAudit } from "./a11y";
import { resetRateLimits } from "./redis";

const BROWSERS = ["chromium", "firefox", "webkit"];

/** Journeys are numbered by their file name: 01-guest-purchase.spec.ts → 1. */
function journeyNumber(file: string): number {
  const match = /(\d+)-[^/\\]+\.spec\.ts$/.exec(file);
  return match ? Number(match[1]) : 0;
}

/**
 * WebKit only: refuse Next.js router prefetches.
 *
 * In Playwright's WebKit (seen on Windows, Next 15.5, React 19.3), clicking a
 * link to a dynamic route *after* its prefetch has completed fetches the page
 * and then never commits the navigation — the old page stays up for good.
 * With the prefetch refused, the click fetches the page itself and navigates
 * normally, which is what a customer gets on a slow connection anyway.
 * Chromium and Firefox are unaffected and keep prefetching. Not yet checked on
 * a real Safari: see the Phase 13 manual device pass.
 */
async function withoutPrefetch(context: BrowserContext, browserName: string): Promise<void> {
  if (browserName !== "webkit") return;
  await context.route(
    (url) => url.searchParams.has("_rsc"),
    (route) =>
      route.request().headers()["next-router-prefetch"] ? route.abort() : route.fallback(),
  );
}

interface Fixtures {
  a11y: A11yAudit;
  slot: number;
  tag: string;
  newAdminPage: () => Promise<Page>;
}

export const test = base.extend<Fixtures>({
  a11y: async ({ page }, use) => {
    const audit = new A11yAudit();
    audit.watch(page);
    await use(audit);
    expect(audit.unchecked(), "pages visited without an axe check").toEqual([]);
  },

  slot: async ({}, use, testInfo) => {
    const browser = Math.max(0, BROWSERS.indexOf(testInfo.project.name));
    await use(journeyNumber(testInfo.file) * BROWSERS.length + browser);
  },

  tag: async ({}, use, testInfo) => {
    const journey = String(journeyNumber(testInfo.file));
    await use(`j${journey}-${testInfo.project.name}`);
  },

  newAdminPage: async ({ browser, browserName, a11y }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async () => {
      const context = await browser.newContext();
      await withoutPrefetch(context, browserName);
      contexts.push(context);
      const page = await context.newPage();
      a11y.watch(page);
      return page;
    });
    for (const context of contexts) await context.close();
  },

  context: async ({ context, browserName }, use) => {
    await withoutPrefetch(context, browserName);
    await use(context);
  },

  page: async ({ page }, use) => {
    await resetRateLimits();
    await use(page);
  },
});

export { expect };
