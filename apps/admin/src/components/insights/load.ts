/*
 * Server-side loaders for the dashboard and analytics pages. Each is wrapped in
 * React `cache`, so blocks that need the same figures in one render (the
 * summary's currency is needed by the revenue chart and the products table)
 * share a single request. Only Server Components import this file.
 */

import type { Schema } from "@velo/api-client";
import { cache } from "react";

import { serverClient } from "@/lib/api-server";

export type Loaded<T> = { ok: true; data: T } | { ok: false; status: number };

type Client = Awaited<ReturnType<typeof serverClient>>;

async function load<T>(
  call: (client: Client) => Promise<{ data?: T | string | undefined; response: Response }>,
): Promise<Loaded<T>> {
  try {
    const { data, response } = await call(await serverClient());
    // Endpoints that can also answer CSV are typed `T | string`; these calls ask for JSON.
    if (response.ok && data !== undefined && typeof data !== "string") return { ok: true, data };
    return { ok: false, status: response.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

function between(since: string, until: string | undefined): { since: string; until?: string } {
  return until === undefined ? { since } : { since, until };
}

const NO_STORE = { cache: "no-store" } as const;

export const loadSummary = cache(
  (since: string, until: string | undefined): Promise<Loaded<Schema<"SummaryView">>> =>
    load((client) =>
      client.GET("/api/v1/admin/analytics/summary", {
        params: { query: between(since, until) },
        ...NO_STORE,
      }),
    ),
);

export const loadRevenue = cache(
  (
    since: string,
    until: string | undefined,
    interval: "day" | "week" | "month",
  ): Promise<Loaded<Schema<"PointView">[]>> =>
    load((client) =>
      client.GET("/api/v1/admin/analytics/revenue", {
        params: { query: { ...between(since, until), interval } },
        ...NO_STORE,
      }),
    ),
);

export const loadTopProducts = cache(
  (
    since: string,
    until: string | undefined,
    limit: number,
  ): Promise<Loaded<Schema<"TopProductView">[]>> =>
    load((client) =>
      client.GET("/api/v1/admin/analytics/products", {
        params: { query: { ...between(since, until), limit } },
        ...NO_STORE,
      }),
    ),
);

export const loadFunnel = cache(
  (since: string, until: string | undefined): Promise<Loaded<Schema<"FunnelView">[]>> =>
    load((client) =>
      client.GET("/api/v1/admin/analytics/funnel", {
        params: { query: between(since, until) },
        ...NO_STORE,
      }),
    ),
);

export const loadCohorts = cache((months: number): Promise<Loaded<Schema<"CohortView">[]>> =>
  load((client) =>
    client.GET("/api/v1/admin/analytics/cohorts", { params: { query: { months } }, ...NO_STORE }),
  ),
);

type OrderQuery = {
  status?: "paid";
  fulfilment_status?: "unfulfilled";
  placed_to?: string;
  limit: number;
};

export const loadOrders = cache(
  (key: string): Promise<Loaded<Schema<"CursorPage_AdminOrderSummaryView_">>> => {
    const query = JSON.parse(key) as OrderQuery;
    return load((client) => client.GET("/api/v1/admin/orders", { params: { query }, ...NO_STORE }));
  },
);

/** `loadOrders` takes a serialised query so `cache` can key on it. */
export function ordersKey(query: OrderQuery): string {
  return JSON.stringify(query);
}

export const loadRequestedReturns = cache((): Promise<Loaded<Schema<"CursorPage_ReturnView_">>> =>
  load((client) =>
    client.GET("/api/v1/admin/returns", {
      params: { query: { status: "requested", limit: 200 } },
      ...NO_STORE,
    }),
  ),
);

export const loadLowStock = cache(
  (limit: number): Promise<Loaded<Schema<"CursorPage_StockRowView_">>> =>
    load((client) =>
      client.GET("/api/v1/admin/inventory", {
        params: { query: { low_stock: true, limit } },
        ...NO_STORE,
      }),
    ),
);
