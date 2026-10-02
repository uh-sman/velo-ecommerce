import type { ProblemDetail } from "@velo/api-client";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import {
  CSRF_COOKIE,
  callApi,
  describeWait,
  fieldErrors,
  problemSlug,
  readCookie,
  refreshSession,
  safeNext,
} from "@/lib/api-browser";
import { apiUrl, fail, offline, ok, on, server } from "@/test/server";

// `refreshSession` keeps its in-flight promise until the next macrotask; let it clear so one
// test's refresh result never answers the next test's call.
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

function getMe() {
  return callApi((client) => client.GET("/api/v1/admin/me"));
}

const ME = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "owner@velo.test",
  first_name: "Olu",
  last_name: "Owner",
  role: "owner",
  permissions: ["admin:access"],
  store_currency: "USD",
};

describe("readCookie", () => {
  it("finds a cookie by exact name and decodes it", () => {
    document.cookie = "velo_csrf_other=nope; path=/";
    document.cookie = `${CSRF_COOKIE}=${encodeURIComponent("a b/c")}; path=/`;
    expect(readCookie(CSRF_COOKIE)).toBe("a b/c");
  });

  it("is undefined when the cookie is absent", () => {
    expect(readCookie("missing")).toBeUndefined();
  });
});

describe("callApi", () => {
  it("echoes the CSRF cookie in X-CSRF-Token without asking the API for one", async () => {
    document.cookie = `${CSRF_COOKIE}=from-cookie; path=/`;
    let header: string | null = null;
    server.use(
      http.get(apiUrl("/api/v1/auth/csrf"), () => {
        throw new Error("CSRF endpoint should not be called when the cookie exists");
      }),
      on("get", "/api/v1/admin/me", ({ request }) => {
        header = request.headers.get("X-CSRF-Token");
        return HttpResponse.json(ME);
      }),
    );
    const outcome = await getMe();
    expect(outcome).toEqual({ ok: true, data: ME });
    expect(header).toBe("from-cookie");
  });

  it("fetches a CSRF token on first contact", async () => {
    let header: string | null = null;
    server.use(
      on("get", "/api/v1/admin/me", ({ request }) => {
        header = request.headers.get("X-CSRF-Token");
        return HttpResponse.json(ME);
      }),
    );
    await getMe();
    expect(header).toBe("test-csrf");
  });

  it("sends an empty token when the CSRF endpoint gives nothing", async () => {
    let header: string | null = "unset";
    server.use(
      fail("get", "/api/v1/auth/csrf", { status: 500 }),
      on("get", "/api/v1/admin/me", ({ request }) => {
        header = request.headers.get("X-CSRF-Token");
        return HttpResponse.json(ME);
      }),
    );
    await getMe();
    expect(header).toBe("");
  });

  it("refreshes an expired session once and retries the call", async () => {
    let calls = 0;
    let refreshes = 0;
    server.use(
      on("post", "/api/v1/auth/refresh", () => {
        refreshes += 1;
        return new HttpResponse(null, { status: 204 });
      }),
      on("get", "/api/v1/admin/me", () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json(
              { type: "x/unauthenticated", title: "Sign in", status: 401 },
              {
                status: 401,
              },
            )
          : HttpResponse.json(ME);
      }),
    );
    const outcome = await getMe();
    expect(outcome.ok).toBe(true);
    expect(calls).toBe(2);
    expect(refreshes).toBe(1);
  });

  it("returns the 401 problem when the refresh fails", async () => {
    server.use(fail("get", "/api/v1/admin/me", { status: 401, slug: "unauthenticated" }));
    const outcome = await getMe();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(problemSlug(outcome.problem)).toBe("unauthenticated");
  });

  it("does not refresh when refreshOnExpiry is off", async () => {
    let refreshes = 0;
    server.use(
      on("post", "/api/v1/auth/refresh", () => {
        refreshes += 1;
        return new HttpResponse(null, { status: 204 });
      }),
      fail("post", "/api/v1/auth/login", { status: 401, slug: "invalid-credentials" }),
    );
    const outcome = await callApi(
      (client) => client.POST("/api/v1/auth/login", { body: { email: "a@b.c", password: "x" } }),
      { refreshOnExpiry: false },
    );
    expect(outcome.ok).toBe(false);
    expect(refreshes).toBe(0);
  });

  it("turns a non-problem error body into a generic problem", async () => {
    server.use(
      http.get(apiUrl("/api/v1/admin/me"), () => new HttpResponse("boom", { status: 502 })),
    );
    const outcome = await getMe();
    expect(outcome).toEqual({
      ok: false,
      problem: {
        type: "https://velo.dev/errors/http-502",
        title: "Something went wrong",
        status: 502,
        detail: "Please try again.",
      },
    });
  });

  it("reports Retry-After in seconds", async () => {
    server.use(
      fail("get", "/api/v1/admin/me", {
        status: 429,
        slug: "too-many-attempts",
        headers: { "Retry-After": "120" },
      }),
    );
    const outcome = await getMe();
    expect(outcome).toMatchObject({ ok: false, retryAfterSeconds: 120 });
  });

  it("reports a network problem when the request never gets an answer", async () => {
    server.use(offline("get", "/api/v1/admin/me"));
    const outcome = await getMe();
    expect(outcome).toMatchObject({
      ok: false,
      problem: { type: "https://velo.dev/errors/network", status: 0 },
    });
  });
});

describe("refreshSession", () => {
  it("treats 409 (another tab already refreshed) as success", async () => {
    server.use(fail("post", "/api/v1/auth/refresh", { status: 409, slug: "refresh-reused" }));
    await expect(refreshSession()).resolves.toBe(true);
  });

  it("is false when the API cannot be reached", async () => {
    server.use(offline("post", "/api/v1/auth/refresh"));
    await expect(refreshSession()).resolves.toBe(false);
  });

  it("shares one refresh between concurrent callers", async () => {
    let refreshes = 0;
    server.use(
      on("post", "/api/v1/auth/refresh", () => {
        refreshes += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const results = await Promise.all([refreshSession(), refreshSession()]);
    expect(results).toEqual([true, true]);
    expect(refreshes).toBe(1);
  });

  it("starts a new refresh once the previous one settled", async () => {
    server.use(ok("post", "/api/v1/auth/refresh", null as never));
    await refreshSession();
    await new Promise((resolve) => setTimeout(resolve, 0));
    server.use(fail("post", "/api/v1/auth/refresh", { status: 401 }));
    await expect(refreshSession()).resolves.toBe(false);
  });
});

describe("problem helpers", () => {
  const problem: ProblemDetail = {
    type: "https://velo.dev/errors/validation-failed",
    title: "Invalid",
    status: 422,
    errors: [
      { field: "email", code: "invalid", message: "Enter an email" },
      { field: "email", code: "taken", message: "Second message is ignored" },
      { field: "name", code: "required", message: "Required" },
    ],
  };

  it("extracts the slug from the problem type", () => {
    expect(problemSlug(problem)).toBe("validation-failed");
  });

  it("keys the first error message by field", () => {
    expect(fieldErrors(problem)).toEqual({ email: "Enter an email", name: "Required" });
  });

  it("is empty when the problem has no field errors", () => {
    expect(fieldErrors({ type: "t", title: "t", status: 400 })).toEqual({});
  });
});

describe("safeNext", () => {
  it.each([
    [null, "/"],
    [undefined, "/"],
    ["", "/"],
    ["https://evil.example", "/"],
    ["//evil.example", "/"],
    ["/\\evil.example", "/"],
    ["/orders?status=paid", "/orders?status=paid"],
  ])("%s → %s", (input, expected) => {
    expect(safeNext(input)).toBe(expected);
  });

  it("uses the given fallback", () => {
    expect(safeNext("evil", "/home")).toBe("/home");
  });
});

describe("describeWait", () => {
  it.each([
    [0, "1 second"],
    [45, "45 seconds"],
    [840, "14 minutes"],
    [3600, "60 minutes"],
    [5400, "2 hours"],
    [7200, "2 hours"],
  ])("%d seconds → %s", (seconds, expected) => {
    expect(describeWait(seconds)).toBe(expected);
  });
});
