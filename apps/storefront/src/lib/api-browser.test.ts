import { HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import {
  callApi,
  CSRF_COOKIE,
  describeWait,
  fieldErrors,
  problemSlug,
  readCookie,
  refreshSession,
  safeNext,
} from "@/lib/api-browser";
import { fail, offline, ok, on, problemResponse, server } from "@/test/server";

/** `refreshSession` shares one in-flight refresh and forgets it on the next tick. */
async function settleRefresh() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(async () => {
  await settleRefresh();
});

const logout = () => callApi((client) => client.POST("/api/v1/auth/logout"));

describe("readCookie", () => {
  it("finds a cookie by exact name and decodes its value", () => {
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
    let csrfFetched = false;
    server.use(
      on("get", "/api/v1/auth/csrf", () => {
        csrfFetched = true;
        return HttpResponse.json({ csrf_token: "unused" });
      }),
      on("post", "/api/v1/auth/logout", ({ request }) => {
        header = request.headers.get("X-CSRF-Token");
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const outcome = await logout();
    expect(outcome.ok).toBe(true);
    expect(header).toBe("from-cookie");
    expect(csrfFetched).toBe(false);
  });

  it("fetches a CSRF token on first contact", async () => {
    let header: string | null = null;
    server.use(
      on("post", "/api/v1/auth/logout", ({ request }) => {
        header = request.headers.get("X-CSRF-Token");
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await logout();
    expect(header).toBe("test-csrf");
  });

  it("sends an empty token when the CSRF endpoint gives none", async () => {
    let header: string | null = "unset";
    server.use(
      fail("get", "/api/v1/auth/csrf", { status: 500 }),
      on("post", "/api/v1/auth/logout", ({ request }) => {
        header = request.headers.get("X-CSRF-Token");
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await logout();
    expect(header).toBe("");
  });

  it("returns the data of a successful call", async () => {
    server.use(
      ok("get", "/api/v1/account/preferences", {
        cart_reminders: true,
        marketing: false,
        order_updates: true,
      }),
    );
    const outcome = await callApi((client) => client.GET("/api/v1/account/preferences"));
    expect(outcome).toEqual({
      ok: true,
      data: { cart_reminders: true, marketing: false, order_updates: true },
    });
  });

  it("refreshes once on a 401 and retries the call", async () => {
    let calls = 0;
    let refreshes = 0;
    server.use(
      on("post", "/api/v1/auth/refresh", () => {
        refreshes += 1;
        return HttpResponse.json({});
      }),
      on("post", "/api/v1/auth/logout", () => {
        calls += 1;
        return calls === 1
          ? problemResponse({ status: 401, slug: "unauthenticated" })
          : new HttpResponse(null, { status: 204 });
      }),
    );
    const outcome = await logout();
    expect(outcome.ok).toBe(true);
    expect(calls).toBe(2);
    expect(refreshes).toBe(1);
  });

  it("returns the 401 problem when the refresh fails", async () => {
    let calls = 0;
    server.use(
      on("post", "/api/v1/auth/logout", () => {
        calls += 1;
        return problemResponse({ status: 401, slug: "unauthenticated", title: "Sign in" });
      }),
    );
    const outcome = await logout();
    expect(calls).toBe(1);
    expect(outcome).toMatchObject({ ok: false, problem: { status: 401, title: "Sign in" } });
  });

  it("does not refresh when told not to", async () => {
    let refreshed = false;
    server.use(
      on("post", "/api/v1/auth/refresh", () => {
        refreshed = true;
        return HttpResponse.json({});
      }),
      fail("post", "/api/v1/auth/login", { status: 401, slug: "invalid-credentials" }),
    );
    const outcome = await callApi(
      (client) => client.POST("/api/v1/auth/login", { body: { email: "a@b.c", password: "x" } }),
      { refreshOnExpiry: false },
    );
    expect(refreshed).toBe(false);
    expect(outcome.ok).toBe(false);
  });

  it("passes an RFC 9457 problem through, with Retry-After in seconds", async () => {
    server.use(
      fail("post", "/api/v1/auth/logout", {
        status: 429,
        slug: "too-many-attempts",
        title: "Slow down",
        headers: { "Retry-After": "120" },
      }),
    );
    const outcome = await logout();
    expect(outcome).toEqual({
      ok: false,
      problem: {
        type: "https://velo.dev/errors/too-many-attempts",
        title: "Slow down",
        status: 429,
      },
      retryAfterSeconds: 120,
    });
  });

  it("invents a generic problem when the error body is not one", async () => {
    server.use(
      on("post", "/api/v1/auth/logout", () => HttpResponse.text("Bad gateway", { status: 502 })),
    );
    const outcome = await logout();
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

  it("reports a network failure as status 0", async () => {
    server.use(offline("post", "/api/v1/auth/logout"));
    const outcome = await logout();
    expect(outcome).toMatchObject({
      ok: false,
      problem: { status: 0, title: "We could not reach the store" },
    });
  });
});

describe("refreshSession", () => {
  it("treats a 409 (another tab already rotated) as success", async () => {
    server.use(fail("post", "/api/v1/auth/refresh", { status: 409, slug: "refresh-reused" }));
    await expect(refreshSession()).resolves.toBe(true);
  });

  it("is false when the refresh request cannot be made", async () => {
    server.use(offline("post", "/api/v1/auth/refresh"));
    await expect(refreshSession()).resolves.toBe(false);
  });

  it("shares one request between concurrent callers", async () => {
    let refreshes = 0;
    server.use(
      on("post", "/api/v1/auth/refresh", () => {
        refreshes += 1;
        return HttpResponse.json({});
      }),
    );
    const results = await Promise.all([refreshSession(), refreshSession(), refreshSession()]);
    expect(results).toEqual([true, true, true]);
    expect(refreshes).toBe(1);
    await settleRefresh();
    await refreshSession();
    expect(refreshes).toBe(2);
  });
});

describe("problem helpers", () => {
  const problem = {
    type: "https://velo.dev/errors/validation-failed",
    title: "Invalid",
    status: 422,
    errors: [
      { field: "email", code: "invalid", message: "Enter a valid email" },
      { field: "email", code: "taken", message: "Second message is ignored" },
      { field: "password", code: "short", message: "Too short" },
    ],
  };

  it("extracts the slug from the problem type", () => {
    expect(problemSlug(problem)).toBe("validation-failed");
  });

  it("keys the first error per field", () => {
    expect(fieldErrors(problem)).toEqual({ email: "Enter a valid email", password: "Too short" });
    expect(fieldErrors({ type: "x", title: "t", status: 400 })).toEqual({});
  });
});

describe("safeNext", () => {
  it.each([
    ["/account/orders", "/account/orders"],
    [null, "/account"],
    [undefined, "/account"],
    ["", "/account"],
    ["https://evil.example", "/account"],
    ["//evil.example", "/account"],
    ["/\\evil.example", "/account"],
  ])("%s → %s", (next, expected) => {
    expect(safeNext(next)).toBe(expected);
  });

  it("uses the given fallback", () => {
    expect(safeNext("nope", "/cart")).toBe("/cart");
  });
});

describe("describeWait", () => {
  it.each([
    [0, "1 second"],
    [1.2, "1 second"],
    [45, "45 seconds"],
    [840, "14 minutes"],
    [3600, "60 minutes"],
    [5400, "2 hours"],
    [3 * 3600, "3 hours"],
  ])("%d seconds → %s", (seconds, expected) => {
    expect(describeWait(seconds)).toBe(expected);
  });
});
