/**
 * The typed API client.
 *
 * `schema.d.ts` is generated from the live OpenAPI document — never hand-edited
 * (ADR-001). If the backend changes a response shape and a call site has not
 * been updated, the type-check fails at build time rather than at runtime in a
 * customer's browser.
 *
 *   pnpm generate:api      # no running API needed
 */

import createClient from "openapi-fetch";

import type { components, paths } from "./schema";

export type { components, paths };

/** A response or request body schema, by its OpenAPI component name. */
export type Schema<Name extends keyof components["schemas"]> = components["schemas"][Name];

export interface ClientOptions {
  /** API origin. Defaults to NEXT_PUBLIC_API_URL, then localhost. */
  baseUrl?: string;
  /** Forwarded headers — cookies on the server, CSRF token in the browser. */
  headers?: Record<string, string>;
}

function resolveBaseUrl(explicit?: string): string {
  if (explicit) return explicit;
  const fromEnv = process.env["NEXT_PUBLIC_API_URL"];
  return fromEnv ?? "http://localhost:8000";
}

/**
 * Build a client.
 *
 * `credentials: "include"` is not optional: authentication is httpOnly cookies
 * (ADR-008), so a client that does not send them is an anonymous client.
 */
export function createApiClient(options: ClientOptions = {}) {
  return createClient<paths>({
    baseUrl: resolveBaseUrl(options.baseUrl),
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
}

/** RFC 9457 problem details — the shape of every error this API returns. */
export interface ProblemDetail {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  request_id?: string;
  errors?: { field: string; code: string; message: string }[];
}

export function isProblemDetail(value: unknown): value is ProblemDetail {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "title" in value &&
    "status" in value
  );
}

/** Money is always integer minor units plus a currency code (ADR-005). */
export interface Money {
  amount: number;
  currency: string;
}

/**
 * Format for display. The client formats; it never computes.
 * `Intl.NumberFormat` knows that JPY has no minor unit and KWD has three, so
 * the divisor is never hard-coded to 100.
 */
export function formatMoney(money: Money, locale = "en-US"): string {
  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: money.currency,
  });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(money.amount / 10 ** digits);
}
