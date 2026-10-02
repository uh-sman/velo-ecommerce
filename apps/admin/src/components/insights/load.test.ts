import { HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import {
  cohort,
  funnelSteps,
  orderSummary,
  pagination,
  point,
  returnRequest,
  stockRow,
  summary,
  topProduct,
} from "@/test/fixtures/insights";
import { fail, offline, ok, on, server } from "@/test/server";

import {
  loadCohorts,
  loadFunnel,
  loadLowStock,
  loadOrders,
  loadRequestedReturns,
  loadRevenue,
  loadSummary,
  loadTopProducts,
  ordersKey,
} from "./load";

// Server Components forward the browser's cookies; outside Next there is no request scope.
vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ toString: () => "velo_access=token-1" }),
}));

const SINCE = "2026-09-03T00:00:00Z";
const UNTIL = "2026-10-03T00:00:00Z";

/** Capture the query string and cookie of the one request a loader sends. */
function capture() {
  const seen: { query: URLSearchParams | null; cookie: string | null } = {
    query: null,
    cookie: null,
  };
  return {
    seen,
    record: (request: Request) => {
      const url = new URL(request.url);
      seen.query = url.searchParams;
      seen.cookie = request.headers.get("cookie");
    },
  };
}

describe("loadSummary", () => {
  it("forwards the session cookie and the window, and returns the data", async () => {
    const { seen, record } = capture();
    const body = summary();
    server.use(
      on("get", "/api/v1/admin/analytics/summary", ({ request }) => {
        record(request);
        return HttpResponse.json(body);
      }),
    );
    await expect(loadSummary(SINCE, UNTIL)).resolves.toEqual({ ok: true, data: body });
    expect(seen.cookie).toBe("velo_access=token-1");
    expect(seen.query?.get("since")).toBe(SINCE);
    expect(seen.query?.get("until")).toBe(UNTIL);
  });

  it("omits `until` for an open-ended window", async () => {
    const { seen, record } = capture();
    server.use(
      on("get", "/api/v1/admin/analytics/summary", ({ request }) => {
        record(request);
        return HttpResponse.json(summary());
      }),
    );
    await loadSummary(SINCE, undefined);
    expect(seen.query?.has("until")).toBe(false);
  });

  it("reports the HTTP status of a problem response", async () => {
    server.use(
      fail("get", "/api/v1/admin/analytics/summary", {
        status: 403,
        slug: "forbidden",
        title: "You do not have permission",
      }),
    );
    await expect(loadSummary(SINCE, UNTIL)).resolves.toEqual({ ok: false, status: 403 });
  });

  it("reports status 0 when the API cannot be reached", async () => {
    server.use(offline("get", "/api/v1/admin/analytics/summary"));
    await expect(loadSummary(SINCE, UNTIL)).resolves.toEqual({ ok: false, status: 0 });
  });
});

describe("the other analytics loaders", () => {
  it("loadRevenue sends the interval", async () => {
    const { seen, record } = capture();
    const body = [point("2026-09-03", 1_000, 1)];
    server.use(
      on("get", "/api/v1/admin/analytics/revenue", ({ request }) => {
        record(request);
        return HttpResponse.json(body);
      }),
    );
    await expect(loadRevenue(SINCE, undefined, "week")).resolves.toEqual({ ok: true, data: body });
    expect(seen.query?.get("interval")).toBe("week");
    expect(seen.query?.get("since")).toBe(SINCE);
  });

  it("loadTopProducts sends the limit", async () => {
    const { seen, record } = capture();
    const body = [topProduct()];
    server.use(
      on("get", "/api/v1/admin/analytics/products", ({ request }) => {
        record(request);
        return HttpResponse.json(body);
      }),
    );
    await expect(loadTopProducts(SINCE, UNTIL, 10)).resolves.toEqual({ ok: true, data: body });
    expect(seen.query?.get("limit")).toBe("10");
    expect(seen.query?.get("until")).toBe(UNTIL);
  });

  it("loadFunnel returns the steps", async () => {
    const body = funnelSteps(10, 5, 4, 3);
    server.use(ok("get", "/api/v1/admin/analytics/funnel", body));
    await expect(loadFunnel(SINCE, undefined)).resolves.toEqual({ ok: true, data: body });
  });

  it("loadCohorts sends the number of months", async () => {
    const { seen, record } = capture();
    const body = [cohort("2026-09-01", 4, [0.25])];
    server.use(
      on("get", "/api/v1/admin/analytics/cohorts", ({ request }) => {
        record(request);
        return HttpResponse.json(body);
      }),
    );
    await expect(loadCohorts(12)).resolves.toEqual({ ok: true, data: body });
    expect(seen.query?.get("months")).toBe("12");
  });

  it("treats a server error as a failed load", async () => {
    server.use(fail("get", "/api/v1/admin/analytics/cohorts", { status: 500 }));
    await expect(loadCohorts(6)).resolves.toEqual({ ok: false, status: 500 });
  });
});

describe("the dashboard loaders", () => {
  it("loadOrders sends the serialised query", async () => {
    const { seen, record } = capture();
    const body = { data: [orderSummary()], pagination: pagination({ total_count: 1 }) };
    server.use(
      on("get", "/api/v1/admin/orders", ({ request }) => {
        record(request);
        return HttpResponse.json(body);
      }),
    );
    const key = ordersKey({
      status: "paid",
      fulfilment_status: "unfulfilled",
      placed_to: "2026-09-30T00:00:00Z",
      limit: 1,
    });
    await expect(loadOrders(key)).resolves.toEqual({ ok: true, data: body });
    expect(seen.query?.get("status")).toBe("paid");
    expect(seen.query?.get("fulfilment_status")).toBe("unfulfilled");
    expect(seen.query?.get("placed_to")).toBe("2026-09-30T00:00:00Z");
    expect(seen.query?.get("limit")).toBe("1");
  });

  it("ordersKey is stable JSON, so equal queries share a cache key", () => {
    expect(ordersKey({ limit: 200 })).toBe('{"limit":200}');
    expect(JSON.parse(ordersKey({ status: "paid", limit: 1 }))).toEqual({
      status: "paid",
      limit: 1,
    });
  });

  it("loadRequestedReturns asks for requested returns only", async () => {
    const { seen, record } = capture();
    const body = { data: [returnRequest()], pagination: pagination() };
    server.use(
      on("get", "/api/v1/admin/returns", ({ request }) => {
        record(request);
        return HttpResponse.json(body);
      }),
    );
    await expect(loadRequestedReturns()).resolves.toEqual({ ok: true, data: body });
    expect(seen.query?.get("status")).toBe("requested");
    expect(seen.query?.get("limit")).toBe("200");
  });

  it("loadLowStock asks for low-stock rows", async () => {
    const { seen, record } = capture();
    const body = { data: [stockRow()], pagination: pagination({ limit: 6 }) };
    server.use(
      on("get", "/api/v1/admin/inventory", ({ request }) => {
        record(request);
        return HttpResponse.json(body);
      }),
    );
    await expect(loadLowStock(6)).resolves.toEqual({ ok: true, data: body });
    expect(seen.query?.get("low_stock")).toBe("true");
    expect(seen.query?.get("limit")).toBe("6");
  });

  it("reports a 401 when the session has expired", async () => {
    server.use(fail("get", "/api/v1/admin/inventory", { status: 401, slug: "unauthenticated" }));
    await expect(loadLowStock(6)).resolves.toEqual({ ok: false, status: 401 });
  });
});
