/**
 * Playwright E2E — PLANNING.md Phase 13: six customer and staff journeys on
 * Chromium, Firefox and WebKit, with axe on every page.
 *
 *   pnpm e2e:install   # browsers, once
 *   pnpm e2e           # starts the API + worker, storefront and admin itself
 *
 * Needs the dev infrastructure running (`pnpm infra:up`: Postgres, Redis,
 * Meilisearch, MailHog). Everything else — ports, database, sandbox payments
 * — is in env.ts.
 */

import { defineConfig, devices } from "@playwright/test";

import {
  ADMIN_PORT,
  ADMIN_URL,
  API_URL,
  STOREFRONT_PORT,
  STOREFRONT_URL,
  apiEnv,
  webEnv,
} from "./env";

const CI = Boolean(process.env["CI"]);

export default defineConfig({
  testDir: "./journeys",
  outputDir: "./test-results",
  globalSetup: "./global-setup.ts",
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  // Every journey drives the same API, worker and two Next servers on one
  // machine. At 3 workers this laptop saw API calls take 5–9 s and client-side
  // navigations stall past their timeouts; 2 runs clean. E2E_WORKERS overrides.
  workers: Number(process.env["E2E_WORKERS"] ?? 2),
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: CI
    ? [["list"], ["html", { outputFolder: "./playwright-report", open: "never" }]]
    : [["list"]],
  use: {
    baseURL: STOREFRONT_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 20_000,
    navigationTimeout: 60_000,
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    colorScheme: "light",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: [
    {
      name: "api",
      command: "node servers/api.mjs",
      url: `${API_URL}/health`,
      env: apiEnv,
      reuseExistingServer: !CI,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "ignore",
    },
    {
      name: "storefront",
      command: `node servers/web.mjs storefront ${String(STOREFRONT_PORT)}`,
      url: `${STOREFRONT_URL}/help/shipping`,
      env: webEnv,
      reuseExistingServer: !CI,
      timeout: 600_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      name: "admin",
      command: `node servers/web.mjs admin ${String(ADMIN_PORT)}`,
      url: `${ADMIN_URL}/sign-in`,
      env: webEnv,
      reuseExistingServer: !CI,
      timeout: 600_000,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
