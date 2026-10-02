import { formatMoney } from "@velo/api-client";
import { AlertTriangleIcon, CheckCircle2Icon, ChevronRightIcon, FlagIcon } from "lucide-react";
import Link from "next/link";

import { EmptyState, Table, formatDateTime, th, td } from "@/components/page";
import { StatusBadge } from "@/components/status";

import { CohortGrid } from "./cohort-grid";
import { formatCount } from "./format";
import { Funnel } from "./funnel";
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
import type { ResolvedRange } from "./range";
import { LoadError } from "./retry";
import { RevenueOverview } from "./revenue-overview";
import { StatTiles } from "./stat-tiles";
import { TopProducts } from "./top-products";

/*
 * The insight blocks, as async Server Components. Each page wraps them in
 * <Suspense> with a skeleton, so the first view is server-rendered and each
 * block streams in on its own; a failure stays inside its block, with a retry.
 */

/** The orders list both the attention block and recent orders read (one request). */
const LATEST_ORDERS = ordersKey({ limit: 200 });
const LOW_STOCK_ROWS = 6;

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

// ── Needs attention ───────────────────────────────────────────────────────────

interface AttentionItem {
  key: string;
  count: string;
  text: string;
  href: string;
}

export async function AttentionBlock({
  orders,
  inventory,
}: {
  orders: boolean;
  inventory: boolean;
}) {
  const cutoff = new Date(Date.now() - 48 * 3_600_000).toISOString();
  const [latest, unfulfilled, stale, returns, lowStock] = await Promise.all([
    orders ? loadOrders(LATEST_ORDERS) : null,
    orders
      ? loadOrders(ordersKey({ status: "paid", fulfilment_status: "unfulfilled", limit: 1 }))
      : null,
    orders
      ? loadOrders(
          ordersKey({
            status: "paid",
            fulfilment_status: "unfulfilled",
            placed_to: cutoff,
            limit: 1,
          }),
        )
      : null,
    orders ? loadRequestedReturns() : null,
    inventory ? loadLowStock(LOW_STOCK_ROWS) : null,
  ]);

  const items: AttentionItem[] = [];
  const failed: string[] = [];

  if (latest?.ok) {
    const flagged = latest.data.data.filter((order) => order.needs_attention);
    const only = flagged[0];
    if (flagged.length > 0) {
      items.push({
        key: "flagged",
        count: formatCount(flagged.length),
        text: `${plural(flagged.length, "order is", "orders are")} flagged — a payment, refund or dispute needs a look${latest.data.pagination.has_more ? " (latest 200 orders)" : ""}`,
        href: flagged.length === 1 && only ? `/orders/${only.id}` : "/orders",
      });
    }
  } else if (latest) failed.push("flagged orders");

  if (unfulfilled?.ok) {
    const total = unfulfilled.data.pagination.total_count ?? unfulfilled.data.data.length;
    const overdue = stale?.ok ? (stale.data.pagination.total_count ?? stale.data.data.length) : 0;
    if (total > 0) {
      items.push({
        key: "unfulfilled",
        count: formatCount(total),
        text: `paid ${plural(total, "order is", "orders are")} waiting to be fulfilled${overdue > 0 ? `, ${formatCount(overdue)} for over 48 hours` : ""}`,
        href: "/orders?status=paid&fulfilment_status=unfulfilled",
      });
    }
  } else if (unfulfilled) failed.push("unfulfilled orders");

  if (returns?.ok) {
    const count = returns.data.data.length;
    if (count > 0) {
      items.push({
        key: "returns",
        count: returns.data.pagination.has_more ? `${formatCount(count)}+` : formatCount(count),
        text: `return ${plural(count, "request is", "requests are")} waiting for a decision`,
        href: "/returns?status=requested",
      });
    }
  } else if (returns) failed.push("returns");

  if (lowStock?.ok) {
    const total = lowStock.data.pagination.total_count ?? lowStock.data.data.length;
    if (total > 0) {
      items.push({
        key: "stock",
        count: formatCount(total),
        text: `${plural(total, "variant is", "variants are")} at or below the reorder point`,
        href: "/inventory?low_stock=true",
      });
    }
  } else if (lowStock) failed.push("stock levels");

  return (
    <div className="flex flex-col gap-3">
      {items.length > 0 ? (
        <ul className="divide-border-subtle m-0 flex list-none flex-col divide-y p-0">
          {items.map((item) => (
            <li key={item.key}>
              <Link
                href={item.href}
                className="hover:bg-surface-sunken -mx-2 flex items-center gap-3 rounded-md px-2 py-2.5 text-sm"
              >
                <AlertTriangleIcon className="text-warning size-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="font-semibold tabular-nums">{item.count}</span> {item.text}
                </span>
                <ChevronRightIcon className="text-text-tertiary size-4 shrink-0" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        failed.length === 0 && (
          <p className="flex items-center gap-2 text-sm">
            <CheckCircle2Icon className="text-success size-4 shrink-0" aria-hidden />
            Nothing needs attention right now.
          </p>
        )
      )}
      {failed.length > 0 && <LoadError what={failed.join(", ")} />}
    </div>
  );
}

// ── Figures and charts ────────────────────────────────────────────────────────

export async function SummaryBlock({ range, period }: { range: ResolvedRange; period: string }) {
  const summary = await loadSummary(range.since, range.until);
  if (!summary.ok) return <LoadError what="the headline figures" status={summary.status} />;
  return <StatTiles summary={summary.data} period={period} />;
}

export async function RevenueBlock({
  range,
  showOrders = false,
}: {
  range: ResolvedRange;
  showOrders?: boolean;
}) {
  const [summary, series] = await Promise.all([
    loadSummary(range.since, range.until),
    loadRevenue(range.since, range.until, range.interval),
  ]);
  if (!series.ok) return <LoadError what="revenue over time" status={series.status} />;
  // The series carries no currency; the summary of the same window does.
  if (!summary.ok) return <LoadError what="revenue over time" status={summary.status} />;
  return (
    <RevenueOverview
      points={series.data}
      currency={summary.data.currency}
      interval={range.interval}
      showOrders={showOrders}
    />
  );
}

export async function FunnelBlock({
  range,
  compact = false,
}: {
  range: ResolvedRange;
  compact?: boolean;
}) {
  const funnel = await loadFunnel(range.since, range.until);
  if (!funnel.ok) return <LoadError what="the conversion funnel" status={funnel.status} />;
  return <Funnel steps={funnel.data} compact={compact} />;
}

export async function TopProductsBlock({ range }: { range: ResolvedRange }) {
  const [summary, products] = await Promise.all([
    loadSummary(range.since, range.until),
    loadTopProducts(range.since, range.until, 10),
  ]);
  if (!products.ok) return <LoadError what="top products" status={products.status} />;
  if (!summary.ok) return <LoadError what="top products" status={summary.status} />;
  if (products.data.length === 0) {
    return (
      <EmptyState title="No sales in this period">Products appear here once they sell.</EmptyState>
    );
  }
  return <TopProducts products={products.data} currency={summary.data.currency} />;
}

export async function CohortBlock({ months }: { months: number }) {
  const cohorts = await loadCohorts(months);
  if (!cohorts.ok) return <LoadError what="retention cohorts" status={cohorts.status} />;
  if (cohorts.data.every((cohort) => cohort.customers === 0)) {
    return (
      <EmptyState title="No customers in these months yet">
        Cohorts fill in as first orders arrive.
      </EmptyState>
    );
  }
  return <CohortGrid cohorts={cohorts.data} />;
}

// ── Lists ─────────────────────────────────────────────────────────────────────

export async function LowStockBlock() {
  const stock = await loadLowStock(LOW_STOCK_ROWS);
  if (!stock.ok) return <LoadError what="stock levels" status={stock.status} />;
  if (stock.data.data.length === 0) {
    return (
      <EmptyState title="Stock is healthy">
        Every tracked variant is above its reorder point.
      </EmptyState>
    );
  }
  return (
    <ul className="divide-border-subtle m-0 flex list-none flex-col divide-y p-0">
      {stock.data.data.map((row) => (
        <li key={row.variant_id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
          <span className="min-w-0">
            <span className="block truncate font-medium">{row.product_title}</span>
            <span className="text-text-secondary block truncate text-xs">
              {row.variant_title} · {row.sku}
            </span>
          </span>
          <span className="shrink-0 text-right">
            <span
              className={
                row.stock.available <= 0
                  ? "text-danger block font-semibold tabular-nums"
                  : "block font-semibold tabular-nums"
              }
            >
              {formatCount(row.stock.available)} available
            </span>
            <span className="text-text-tertiary block text-xs tabular-nums">
              reorder at {formatCount(row.stock.reorder_point)}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export async function RecentOrdersBlock() {
  const latest = await loadOrders(LATEST_ORDERS);
  if (!latest.ok) return <LoadError what="recent orders" status={latest.status} />;
  const orders = latest.data.data.slice(0, 8);
  if (orders.length === 0) {
    return (
      <EmptyState title="No orders yet">New orders appear here as they are placed.</EmptyState>
    );
  }
  return (
    <Table label="Recent orders">
      <thead>
        <tr>
          <th scope="col" className={th}>
            Order
          </th>
          <th scope="col" className={th}>
            Customer
          </th>
          <th scope="col" className={th}>
            Placed
          </th>
          <th scope="col" className={th}>
            Status
          </th>
          <th scope="col" className={`${th} text-right`}>
            Total
          </th>
        </tr>
      </thead>
      <tbody>
        {orders.map((order) => (
          <tr key={order.id} className="hover:bg-surface-sunken">
            <td className={td}>
              <Link
                href={`/orders/${order.id}`}
                className="inline-flex items-center gap-1.5 font-medium underline-offset-4 hover:underline"
              >
                {order.number}
                {order.needs_attention && (
                  <>
                    <FlagIcon className="text-warning size-3.5" aria-hidden />
                    <span className="sr-only">(needs attention)</span>
                  </>
                )}
              </Link>
            </td>
            <td className={`${td} max-w-48 truncate`}>{order.customer_name ?? order.email}</td>
            <td className={`${td} text-text-secondary whitespace-nowrap`}>
              {formatDateTime(order.placed_at)}
            </td>
            <td className={td}>
              <StatusBadge status={order.status} />
            </td>
            <td className={`${td} text-right tabular-nums`}>{formatMoney(order.total)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
