/**
 * Calling the API from the browser.
 *
 * Two things every call needs, done once here:
 *
 * - **CSRF.** Mutations echo the `velo_csrf` cookie in `X-CSRF-Token`
 *   (API-SPEC.md §1). The cookie is set by the API and readable by design.
 * - **Silent refresh.** The access cookie lives 15 minutes. A 401 triggers one
 *   `POST /auth/refresh` and one retry, so an expired access token is invisible
 *   to the customer. Concurrent 401s share a single refresh.
 */

import { createApiClient, isProblemDetail, type ProblemDetail } from "@velo/api-client";

export const CSRF_COOKIE = "velo_csrf";

type Client = ReturnType<typeof createApiClient>;

export type Outcome<T> =
  { ok: true; data: T } | { ok: false; problem: ProblemDetail; retryAfterSeconds?: number };

type Call<T> = (client: Client) => Promise<{
  data?: T | undefined;
  error?: unknown;
  response: Response;
}>;

export function readCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  for (const part of document.cookie.split("; ")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator) === name) {
      return decodeURIComponent(part.slice(separator + 1));
    }
  }
  return undefined;
}

async function csrfToken(): Promise<string> {
  const existing = readCookie(CSRF_COOKIE);
  if (existing) return existing;
  // First contact: the API sets the cookie and returns the same value.
  const { data } = await createApiClient().GET("/api/v1/auth/csrf");
  return data?.csrf_token ?? readCookie(CSRF_COOKIE) ?? "";
}

async function client(): Promise<Client> {
  return createApiClient({ headers: { "X-CSRF-Token": await csrfToken() } });
}

let refreshing: Promise<boolean> | null = null;

/**
 * Rotate the session. True if the browser now holds a valid access cookie.
 *
 * A 409 means another tab refreshed with the same token a moment earlier and
 * its response already set fresh cookies in this browser — success, not theft.
 */
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const { response } = await (await client()).POST("/api/v1/auth/refresh");
      return response.ok || response.status === 409;
    } catch {
      return false;
    } finally {
      setTimeout(() => {
        refreshing = null;
      }, 0);
    }
  })();
  return refreshing;
}

const NETWORK_PROBLEM: ProblemDetail = {
  type: "https://velo.dev/errors/network",
  title: "We could not reach the store",
  status: 0,
  detail: "Check your connection and try again.",
};

function toProblem(error: unknown, response: Response): ProblemDetail {
  if (isProblemDetail(error)) return error;
  return {
    type: `https://velo.dev/errors/http-${String(response.status)}`,
    title: "Something went wrong",
    status: response.status,
    detail: "Please try again.",
  };
}

export async function callApi<T>(
  call: Call<T>,
  { refreshOnExpiry = true }: { refreshOnExpiry?: boolean } = {},
): Promise<Outcome<T>> {
  try {
    let result = await call(await client());
    if (result.response.status === 401 && refreshOnExpiry && (await refreshSession())) {
      result = await call(await client());
    }
    if (result.response.ok) return { ok: true, data: result.data as T };
    const problem = toProblem(result.error, result.response);
    const retryAfter = Number(result.response.headers.get("Retry-After"));
    return retryAfter > 0
      ? { ok: false, problem, retryAfterSeconds: retryAfter }
      : { ok: false, problem };
  } catch {
    return { ok: false, problem: NETWORK_PROBLEM };
  }
}

/** The stable slug of a problem type: `https://velo.dev/errors/email-taken` → `email-taken`. */
export function problemSlug(problem: ProblemDetail): string {
  return problem.type.slice(problem.type.lastIndexOf("/") + 1);
}

/** Field errors keyed by field name, for inline display. */
export function fieldErrors(problem: ProblemDetail): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const error of problem.errors ?? []) {
    errors[error.field] ??= error.message;
  }
  return errors;
}

/**
 * Only same-site relative paths are followed after sign-in. Anything else —
 * `https://evil.example`, `//evil.example`, `/\evil.example` — is an open
 * redirect, and falls back to the account page.
 */
export function safeNext(next: string | null | undefined, fallback = "/account"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return fallback;
  }
  return next;
}

/** "14 minutes", "1 hour" — for honest cooldown messages. */
export function describeWait(seconds: number): string {
  if (seconds < 90) {
    const whole = Math.max(1, Math.round(seconds));
    return whole === 1 ? "1 second" : `${String(whole)} seconds`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${String(minutes)} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "1 hour" : `${String(hours)} hours`;
}
