/**
 * MSW for the browser API client.
 *
 * `lib/api-browser.ts` builds its client with `createApiClient()`, whose base
 * URL is `NEXT_PUBLIC_API_URL` or `http://localhost:8000`; `vitest.config.ts`
 * pins the variable so every handler here matches what components request.
 *
 * Helpers are typed against the generated OpenAPI `paths`, so a fixture that
 * drifts from the real response shape fails the type-check, not just a test.
 */

import { http, HttpResponse, type DefaultBodyType, type HttpResponseResolver } from "msw";
import { setupServer } from "msw/node";
import type { ProblemDetail, paths } from "@velo/api-client";

export const API_URL = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:8000";

type Method = "get" | "post" | "put" | "patch" | "delete";
type Path = keyof paths;
type Operation<P extends Path, M extends Method> = NonNullable<paths[P][M]>;

type JsonContent<R> = R extends { content: { "application/json": infer B } } ? B : null;

/** The JSON body of the operation's success response (200, 201 or 204). */
export type Ok<P extends Path, M extends Method> =
  Operation<P, M> extends { responses: infer R }
    ? 200 extends keyof R
      ? JsonContent<R[200]>
      : 201 extends keyof R
        ? JsonContent<R[201]>
        : 202 extends keyof R
          ? JsonContent<R[202]>
          : null
    : never;

/** `/api/v1/orders/{number}` → `http://localhost:8000/api/v1/orders/:number`. */
export function apiUrl(path: Path): string {
  return API_URL + path.replace(/\{(\w+)\}/g, ":$1");
}

type Resolver = HttpResponseResolver<Record<string, string | readonly string[]>, DefaultBodyType>;

/** A handler with full access to the request, for assertions on what was sent. */
export function on<P extends Path, M extends Method>(method: M, path: P, resolver: Resolver) {
  return http[method](apiUrl(path), resolver);
}

/** Answer an operation with a typed success body. */
export function ok<P extends Path, M extends Method>(
  method: M,
  path: P,
  body: Ok<P, M>,
  status = 200,
) {
  return http[method](apiUrl(path), () =>
    status === 204 ? new HttpResponse(null, { status }) : HttpResponse.json(body, { status }),
  );
}

export interface ProblemInit {
  status: number;
  slug?: string;
  title?: string;
  detail?: string;
  errors?: ProblemDetail["errors"];
  headers?: Record<string, string>;
}

/** An RFC 9457 problem document, as the API returns for every error. */
export function problemBody({ status, slug, title, detail, errors }: ProblemInit) {
  return {
    type: `https://velo.dev/errors/${slug ?? `http-${String(status)}`}`,
    title: title ?? "Something went wrong",
    status,
    ...(detail === undefined ? {} : { detail }),
    ...(errors === undefined ? {} : { errors }),
  };
}

export function problemResponse(init: ProblemInit) {
  return HttpResponse.json(problemBody(init), {
    status: init.status,
    headers: { "Content-Type": "application/problem+json", ...init.headers },
  });
}

/** Answer an operation with an RFC 9457 problem. */
export function fail<P extends Path>(method: Method, path: P, init: ProblemInit) {
  return http[method](apiUrl(path), () => problemResponse(init));
}

/** A transport failure: the request never got an HTTP answer. */
export function offline<P extends Path>(method: Method, path: P) {
  return http[method](apiUrl(path), () => HttpResponse.error());
}

/**
 * Defaults every test gets: a CSRF token, and an anonymous visitor whose
 * session cannot be refreshed. Anything else must be declared by the test, and
 * an undeclared request fails it (`onUnhandledRequest: "error"` in setup).
 */
export const defaultHandlers = [
  ok("get", "/api/v1/auth/csrf", { csrf_token: "test-csrf" }),
  fail("post", "/api/v1/auth/refresh", { status: 401, slug: "unauthenticated", title: "Sign in" }),
];

export const server = setupServer(...defaultHandlers);
