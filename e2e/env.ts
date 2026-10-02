/**
 * The E2E environment: one place for every port, URL and setting the suite
 * starts its servers with.
 *
 * Isolated from development and the pytest suite: its own database
 * (`velo_e2e`), Redis database (3), Meilisearch index (`products_e2e`) and
 * ports (API 8100, storefront 3100, admin 3101), so a dev server on the usual
 * ports is never reused by mistake. Every value can be overridden from the
 * environment.
 *
 * Service URLs use 127.0.0.1, not localhost: on Docker Desktop for Windows,
 * localhost resolves to IPv6 first and the relay adds latency. The browser,
 * though, talks to the apps and the API as `localhost` — the session cookies
 * are scoped to that domain (VELO_COOKIE_DOMAIN).
 */

const env = process.env;

export const API_PORT = Number(env["E2E_API_PORT"] ?? 8100);
export const STOREFRONT_PORT = Number(env["E2E_STOREFRONT_PORT"] ?? 3100);
export const ADMIN_PORT = Number(env["E2E_ADMIN_PORT"] ?? 3101);

export const API_URL = `http://localhost:${String(API_PORT)}`;
export const STOREFRONT_URL = `http://localhost:${String(STOREFRONT_PORT)}`;
export const ADMIN_URL = `http://localhost:${String(ADMIN_PORT)}`;

export const REDIS_URL = env["E2E_REDIS_URL"] ?? "redis://127.0.0.1:16379/3";

export const ADMIN_EMAIL = "admin@velo.dev";
export const CUSTOMER_EMAIL = "customer@velo.dev";
export const DEMO_PASSWORD = "ChangeMe123!";

/** What the API, the worker, and the migrate/seed scripts run with. */
export const apiEnv: Record<string, string> = {
  VELO_ENV: "development",
  VELO_DEBUG: "false",
  VELO_SECRET_KEY: env["E2E_SECRET_KEY"] ?? "e2e-only-secret-key-not-for-any-real-deployment",
  VELO_DATABASE_URL:
    env["E2E_DATABASE_URL"] ?? "postgresql+asyncpg://velo:velo@127.0.0.1:5433/velo_e2e",
  VELO_REDIS_URL: REDIS_URL,
  VELO_MEILISEARCH_URL: env["E2E_MEILISEARCH_URL"] ?? "http://127.0.0.1:7700",
  VELO_MEILISEARCH_MASTER_KEY: env["E2E_MEILISEARCH_MASTER_KEY"] ?? "local-dev-master-key",
  VELO_MEILISEARCH_INDEX: "products_e2e",
  VELO_COOKIE_DOMAIN: "localhost",
  VELO_COOKIE_SECURE: "false",
  VELO_CORS_ORIGINS: `${STOREFRONT_URL},${ADMIN_URL}`,
  VELO_STOREFRONT_URL: STOREFRONT_URL,
  VELO_ADMIN_URL: ADMIN_URL,
  VELO_PUBLIC_API_URL: API_URL,
  // The sandbox provider: pays, declines and refunds without leaving the machine.
  VELO_PAYMENT_SANDBOX: "true",
  VELO_PAYMENT_DEFAULT_PROVIDER: "sandbox",
  VELO_STRIPE_SECRET_KEY: "",
  VELO_STRIPE_WEBHOOK_SECRET: "",
  VELO_PAYSTACK_SECRET_KEY: "",
  // Email goes to MailHog, never to a real inbox.
  VELO_RESEND_API_KEY: "",
  VELO_SMTP_HOST: "127.0.0.1",
  VELO_SMTP_PORT: env["E2E_SMTP_PORT"] ?? "1026",
  // No calls to Have I Been Pwned from a test run.
  VELO_BREACH_CHECK_ENABLED: "false",
  VELO_CATALOG_CACHE_TTL_SECONDS: "0",
  PYTHONUNBUFFERED: "1",
  PYTHONIOENCODING: "utf-8",
};

/** What the Next.js apps are built and started with. */
export const webEnv: Record<string, string> = {
  NEXT_PUBLIC_API_URL: API_URL,
  NEXT_PUBLIC_STOREFRONT_URL: STOREFRONT_URL,
  NEXT_TELEMETRY_DISABLED: "1",
  // Node's file reads, DNS lookups and zlib share a pool of 4 threads. Under
  // the suite's load a static JS chunk once took 15 s to arrive (suspected:
  // slow disk I/O on Windows holding every pool thread), and the click that
  // needed it timed out. A larger pool costs nothing.
  UV_THREADPOOL_SIZE: "32",
};
