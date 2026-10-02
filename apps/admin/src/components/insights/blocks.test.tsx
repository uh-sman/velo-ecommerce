import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Schema } from "@velo/api-client";
import { HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

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
import { router } from "@/test/navigation";
import { fail, offline, ok, on, server } from "@/test/server";

import {
  AttentionBlock,
  CohortBlock,
  FunnelBlock,
  LowStockBlock,
  RecentOrdersBlock,
  RevenueBlock,
  SummaryBlock,
  TopProductsBlock,
} from "./blocks";
import { presetRange, resolveRange } from "./range";

// The loaders forward the request's cookies; outside Next there is no request scope.
vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ toString: () => "velo_access=token-1" }),
}));

const NOW = new Date("2026-10-02T12:00:00Z");
const RANGE = presetRange(30, NOW);

afterEach(() => {
  vi.useRealTimers();
});

const SUMMARY = "/api/v1/admin/analytics/summary";
const REVENUE = "/api/v1/admin/analytics/revenue";
const PRODUCTS = "/api/v1/admin/analytics/products";
const FUNNEL = "/api/v1/admin/analytics/funnel";
const COHORTS = "/api/v1/admin/analytics/cohorts";
const ORDERS = "/api/v1/admin/orders";
const RETURNS = "/api/v1/admin/returns";
const INVENTORY = "/api/v1/admin/inventory";

type OrderPage = Schema<"CursorPage_AdminOrderSummaryView_">;

function orderPage(
  data: Schema<"AdminOrderSummaryView">[],
  info: Partial<Schema<"PaginationInfo">> = {},
): OrderPage {
  return { data, pagination: pagination(info) };
}

/**
 * The attention block asks /orders three ways: the latest 200 (flagged), the
 * unfulfilled count, and the unfulfilled count older than 48 hours.
 */
function ordersByQuery(pages: {
  latest: OrderPage | number;
  unfulfilled: OrderPage | number;
  stale: OrderPage | number;
}) {
  const seen: URLSearchParams[] = [];
  const handler = on("get", ORDERS, ({ request }) => {
    const query = new URL(request.url).searchParams;
    seen.push(query);
    const page =
      query.get("limit") === "200"
        ? pages.latest
        : query.has("placed_to")
          ? pages.stale
          : pages.unfulfilled;
    return typeof page === "number"
      ? HttpResponse.json(
          { type: "https://velo.dev/errors/http-error", title: "Failed", status: page },
          { status: page, headers: { "Content-Type": "application/problem+json" } },
        )
      : HttpResponse.json(page);
  });
  return { handler, seen };
}

describe("AttentionBlock", () => {
  it("lists what needs a look, each linking to the filtered list", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const flagged = [
      orderSummary({ needs_attention: true }),
      orderSummary({ needs_attention: true }),
      orderSummary(),
    ];
    const { handler, seen } = ordersByQuery({
      latest: orderPage(flagged, { has_more: true }),
      unfulfilled: orderPage([orderSummary()], { total_count: 5 }),
      stale: orderPage([orderSummary()], { total_count: 2 }),
    });
    server.use(
      handler,
      ok("get", RETURNS, {
        data: [returnRequest(), returnRequest(), returnRequest()],
        pagination: pagination({ has_more: true }),
      }),
      ok("get", INVENTORY, { data: [stockRow()], pagination: pagination() }),
    );

    render(await AttentionBlock({ orders: true, inventory: true }));

    const links = screen.getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      [
        "2 orders are flagged — a payment, refund or dispute needs a look (latest 200 orders)",
        "/orders",
      ],
      [
        "5 paid orders are waiting to be fulfilled, 2 for over 48 hours",
        "/orders?status=paid&fulfilment_status=unfulfilled",
      ],
      ["3+ return requests are waiting for a decision", "/returns?status=requested"],
      ["1 variant is at or below the reorder point", "/inventory?low_stock=true"],
    ]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // "Over 48 hours" means placed before now minus 48 hours.
    expect(seen.find((query) => query.has("placed_to"))?.get("placed_to")).toBe(
      "2026-09-30T12:00:00.000Z",
    );
  });

  it("links a single flagged order directly and words singulars", async () => {
    const only = orderSummary({ needs_attention: true });
    const { handler } = ordersByQuery({
      latest: orderPage([only]),
      unfulfilled: orderPage([orderSummary()]),
      stale: 500,
    });
    server.use(
      handler,
      ok("get", RETURNS, { data: [returnRequest()], pagination: pagination() }),
      ok("get", INVENTORY, {
        data: [stockRow(), stockRow()],
        pagination: pagination({ total_count: 7 }),
      }),
    );

    render(await AttentionBlock({ orders: true, inventory: true }));

    expect(screen.getByRole("link", { name: /order is flagged/ })).toHaveAttribute(
      "href",
      `/orders/${only.id}`,
    );
    expect(screen.getByRole("link", { name: /order is flagged/ })).not.toHaveTextContent(
      "latest 200",
    );
    // Without a total the page length is the count; a failed overdue count is left out.
    expect(
      screen.getByRole("link", { name: "1 paid order is waiting to be fulfilled" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "1 return request is waiting for a decision" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "7 variants are at or below the reorder point" }),
    ).toBeInTheDocument();
  });

  it("says when nothing needs attention", async () => {
    const { handler } = ordersByQuery({
      latest: orderPage([orderSummary()]),
      unfulfilled: orderPage([], { total_count: 0 }),
      stale: orderPage([], { total_count: 0 }),
    });
    server.use(
      handler,
      ok("get", RETURNS, { data: [], pagination: pagination() }),
      ok("get", INVENTORY, { data: [], pagination: pagination({ total_count: 0 }) }),
    );
    render(await AttentionBlock({ orders: true, inventory: true }));
    expect(screen.getByText("Nothing needs attention right now.")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("asks for nothing the role cannot see", async () => {
    // No handlers: any request would fail the test (onUnhandledRequest: "error").
    render(await AttentionBlock({ orders: false, inventory: false }));
    expect(screen.getByText("Nothing needs attention right now.")).toBeInTheDocument();
  });

  it("names every source that failed, with a retry, instead of an all-clear", async () => {
    const user = userEvent.setup();
    const { handler } = ordersByQuery({ latest: 500, unfulfilled: 503, stale: 503 });
    server.use(handler, fail("get", RETURNS, { status: 500 }), offline("get", INVENTORY));

    render(await AttentionBlock({ orders: true, inventory: true }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "We could not load flagged orders, unfulfilled orders, returns, stock levels.",
    );
    expect(screen.queryByText("Nothing needs attention right now.")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(router.refresh).toHaveBeenCalled();
  });

  it("keeps what loaded beside what failed", async () => {
    server.use(
      ok("get", INVENTORY, { data: [stockRow()], pagination: pagination({ total_count: 3 }) }),
    );
    const { handler } = ordersByQuery({ latest: 500, unfulfilled: 500, stale: 500 });
    server.use(handler, fail("get", RETURNS, { status: 500 }));
    render(await AttentionBlock({ orders: true, inventory: true }));
    expect(
      screen.getByRole("link", { name: "3 variants are at or below the reorder point" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "We could not load flagged orders, unfulfilled orders, returns.",
    );
  });
});

describe("SummaryBlock", () => {
  it("shows the headline figures for the window", async () => {
    let query: URLSearchParams | undefined;
    server.use(
      on("get", SUMMARY, ({ request }) => {
        query = new URL(request.url).searchParams;
        return HttpResponse.json(summary());
      }),
    );
    render(await SummaryBlock({ range: RANGE, period: "30 days" }));
    expect(screen.getByText("Revenue").parentElement).toHaveTextContent(
      "Up 20% vs previous 30 days",
    );
    expect(query?.get("since")).toBe("2026-09-03T00:00:00Z");
    expect(query?.has("until")).toBe(false);
  });

  it("sends the exclusive end of a custom window", async () => {
    let query: URLSearchParams | undefined;
    server.use(
      on("get", SUMMARY, ({ request }) => {
        query = new URL(request.url).searchParams;
        return HttpResponse.json(summary());
      }),
    );
    const range = resolveRange({ range: "custom", from: "2026-08-01", to: "2026-08-31" }, NOW);
    render(await SummaryBlock({ range, period: "31 days" }));
    expect(query?.get("until")).toBe("2026-09-01T00:00:00Z");
  });

  it("explains a 403 without offering a retry", async () => {
    server.use(fail("get", SUMMARY, { status: 403, slug: "forbidden", title: "Forbidden" }));
    render(await SummaryBlock({ range: RANGE, period: "30 days" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "You do not have access to the headline figures.",
    );
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("retries a failed load by re-rendering the route", async () => {
    const user = userEvent.setup();
    server.use(fail("get", SUMMARY, { status: 500, slug: "internal", title: "Server error" }));
    const { unmount } = render(await SummaryBlock({ range: RANGE, period: "30 days" }));
    expect(screen.getByRole("alert")).toHaveTextContent("We could not load the headline figures.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(router.refresh).toHaveBeenCalledTimes(1);

    // The refresh re-runs the Server Component; this time the API answers.
    unmount();
    server.use(ok("get", SUMMARY, summary()));
    render(await SummaryBlock({ range: RANGE, period: "30 days" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("$4,800.00")).toBeInTheDocument();
  });
});

describe("RevenueBlock", () => {
  it("draws the series in the summary's currency, at the range's interval", async () => {
    let interval: string | null = null;
    server.use(
      ok("get", SUMMARY, summary({ currency: "EUR" })),
      on("get", REVENUE, ({ request }) => {
        interval = new URL(request.url).searchParams.get("interval");
        return HttpResponse.json([point("2026-09-03", 10_000, 2, "EUR")]);
      }),
    );
    render(await RevenueBlock({ range: { ...RANGE, interval: "week" }, showOrders: true }));
    expect(interval).toBe("week");
    expect(screen.getByText("Revenue per week · €100.00 in total")).toBeInTheDocument();
    expect(screen.getByText("Orders per week · 2 in total")).toBeInTheDocument();
  });

  it("leaves out orders by default", async () => {
    server.use(ok("get", SUMMARY, summary()), ok("get", REVENUE, [point("2026-09-03", 0, 0)]));
    render(await RevenueBlock({ range: RANGE }));
    expect(screen.getAllByRole("slider")).toHaveLength(1);
  });

  it("fails when the series fails", async () => {
    server.use(ok("get", SUMMARY, summary()), fail("get", REVENUE, { status: 500 }));
    render(await RevenueBlock({ range: RANGE }));
    expect(screen.getByRole("alert")).toHaveTextContent("We could not load revenue over time.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("fails when the currency (from the summary) is missing", async () => {
    server.use(
      fail("get", SUMMARY, { status: 403, slug: "forbidden" }),
      ok("get", REVENUE, [point("2026-09-03", 0, 0)]),
    );
    render(await RevenueBlock({ range: RANGE }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "You do not have access to revenue over time.",
    );
  });
});

describe("FunnelBlock", () => {
  it("shows the funnel", async () => {
    server.use(ok("get", FUNNEL, funnelSteps(100, 50, 40, 20)));
    render(await FunnelBlock({ range: RANGE, compact: true }));
    expect(screen.getByRole("list", { name: "Conversion funnel" })).toBeInTheDocument();
    expect(screen.getByText("Carts to orders:").parentElement).toHaveTextContent("20%");
  });

  it("shows an error with a retry", async () => {
    server.use(offline("get", FUNNEL));
    render(await FunnelBlock({ range: RANGE }));
    expect(screen.getByRole("alert")).toHaveTextContent("We could not load the conversion funnel.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

describe("TopProductsBlock", () => {
  it("lists the top ten in the summary's currency", async () => {
    let limit: string | null = null;
    server.use(
      ok("get", SUMMARY, summary({ currency: "GBP" })),
      on("get", PRODUCTS, ({ request }) => {
        limit = new URL(request.url).searchParams.get("limit");
        return HttpResponse.json([topProduct({ revenue: 12_345, currency: "GBP" })]);
      }),
    );
    render(await TopProductsBlock({ range: RANGE }));
    expect(limit).toBe("10");
    expect(screen.getByRole("table", { name: "Top products by revenue" })).toHaveTextContent(
      "£123.45",
    );
  });

  it("has an empty state when nothing sold", async () => {
    server.use(ok("get", SUMMARY, summary()), ok("get", PRODUCTS, []));
    render(await TopProductsBlock({ range: RANGE }));
    expect(screen.getByText("No sales in this period")).toBeInTheDocument();
    expect(screen.getByText("Products appear here once they sell.")).toBeInTheDocument();
  });

  it("fails when the products fail", async () => {
    server.use(ok("get", SUMMARY, summary()), fail("get", PRODUCTS, { status: 500 }));
    render(await TopProductsBlock({ range: RANGE }));
    expect(screen.getByRole("alert")).toHaveTextContent("We could not load top products.");
  });

  it("fails when the summary fails", async () => {
    server.use(fail("get", SUMMARY, { status: 502 }), ok("get", PRODUCTS, [topProduct()]));
    render(await TopProductsBlock({ range: RANGE }));
    expect(screen.getByRole("alert")).toHaveTextContent("We could not load top products.");
  });
});

describe("CohortBlock", () => {
  it("shows the grid for the requested months", async () => {
    let months: string | null = null;
    server.use(
      on("get", COHORTS, ({ request }) => {
        months = new URL(request.url).searchParams.get("months");
        return HttpResponse.json([cohort("2026-08-01", 10, [0.3])]);
      }),
    );
    render(await CohortBlock({ months: 12 }));
    expect(months).toBe("12");
    expect(screen.getByRole("rowheader", { name: "Aug 2026" })).toBeInTheDocument();
  });

  it("has an empty state before any customer", async () => {
    server.use(ok("get", COHORTS, [cohort("2026-08-01", 0, [0]), cohort("2026-09-01", 0, [])]));
    render(await CohortBlock({ months: 6 }));
    expect(screen.getByText("No customers in these months yet")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows an error", async () => {
    server.use(fail("get", COHORTS, { status: 500 }));
    render(await CohortBlock({ months: 6 }));
    expect(screen.getByRole("alert")).toHaveTextContent("We could not load retention cohorts.");
  });
});

describe("LowStockBlock", () => {
  it("lists low variants, highlighting those with none available", async () => {
    server.use(
      ok("get", INVENTORY, {
        data: [
          stockRow(),
          stockRow({
            variant_id: "66666666-6666-4666-8666-666666666666",
            product_title: "Rain Shell",
            variant_title: "Large",
            sku: "RS-L",
            stock: { ...stockRow().stock, available: 0, reorder_point: 1_000 },
          }),
        ],
        pagination: pagination(),
      }),
    );
    render(await LowStockBlock());
    const [first, second] = screen.getAllByRole("listitem");
    expect(first).toHaveTextContent("Trail RunnerSize 42 · TR-422 availablereorder at 5");
    expect(second).toHaveTextContent("Rain ShellLarge · RS-L0 availablereorder at 1,000");
    expect(within(second as HTMLElement).getByText("0 available")).toHaveClass("text-danger");
    expect(within(first as HTMLElement).getByText("2 available")).not.toHaveClass("text-danger");
  });

  it("says stock is healthy when nothing is low", async () => {
    server.use(ok("get", INVENTORY, { data: [], pagination: pagination() }));
    render(await LowStockBlock());
    expect(screen.getByText("Stock is healthy")).toBeInTheDocument();
  });

  it("shows an error", async () => {
    server.use(fail("get", INVENTORY, { status: 403, slug: "forbidden" }));
    render(await LowStockBlock());
    expect(screen.getByRole("alert")).toHaveTextContent("You do not have access to stock levels.");
  });
});

describe("RecentOrdersBlock", () => {
  it("shows the eight latest orders, flagging those that need attention", async () => {
    const orders = Array.from({ length: 10 }, (_, index) =>
      orderSummary(
        index === 0
          ? { needs_attention: true, customer_name: null, email: "guest@example.com" }
          : { total: { amount: 1_000 * (index + 1), currency: "USD" }, status: "delivered" },
      ),
    );
    server.use(ok("get", ORDERS, orderPage(orders)));
    render(await RecentOrdersBlock());
    const table = screen.getByRole("table", { name: "Recent orders" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(8);

    const first = orders[0];
    if (!first) throw new Error("fixture");
    const link = within(rows[0] as HTMLElement).getByRole("link");
    expect(link).toHaveAttribute("href", `/orders/${first.id}`);
    expect(link).toHaveAccessibleName(`${first.number} (needs attention)`);
    expect(rows[0]).toHaveTextContent("guest@example.com");
    expect(rows[0]).toHaveTextContent("Confirmed");
    expect(rows[0]).toHaveTextContent("$49.99");

    expect(within(rows[1] as HTMLElement).getByRole("link")).not.toHaveTextContent(
      "needs attention",
    );
    expect(rows[1]).toHaveTextContent("Ada Lovelace");
    expect(rows[1]).toHaveTextContent("Delivered");
    expect(rows[1]).toHaveTextContent("$20.00");
  });

  it("has an empty state", async () => {
    server.use(ok("get", ORDERS, orderPage([])));
    render(await RecentOrdersBlock());
    expect(screen.getByText("No orders yet")).toBeInTheDocument();
  });

  it("shows an error with a retry", async () => {
    server.use(fail("get", ORDERS, { status: 500 }));
    render(await RecentOrdersBlock());
    expect(screen.getByRole("alert")).toHaveTextContent("We could not load recent orders.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
