import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import {
  AttentionBlock,
  FunnelBlock,
  LowStockBlock,
  RecentOrdersBlock,
  RevenueBlock,
  SummaryBlock,
} from "@/components/insights/blocks";
import { presetRange } from "@/components/insights/range";
import { ChartSkeleton, ListSkeleton, TilesSkeleton } from "@/components/insights/skeletons";
import { PageHeader, Section } from "@/components/page";
import { getMe } from "@/lib/api-server";
import { can } from "@/lib/permissions";

export const metadata: Metadata = { title: "Dashboard" };

/*
 * PAGE-SPECS.md §3.1: "is anything wrong, and what needs doing today?" in five
 * seconds. Problems first, then performance (the last 30 UTC days against the
 * 30 before), then the lists. Each block is shown only to roles that can read
 * it — the API checks again — so a fulfilment user sees the attention block
 * and the lists, and no money.
 */
export default async function DashboardPage() {
  const me = await getMe();
  if (me === null || me === "forbidden") return null; // the layout has already handled these
  const reports = can(me.permissions, "reports:read");
  const orders = can(me.permissions, "orders:read");
  const inventory = can(me.permissions, "admin:access");
  const range = presetRange(30);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Dashboard"
        description={
          reports
            ? "The last 30 days against the 30 before. Days are UTC days."
            : "Today at a glance."
        }
        actions={
          reports && (
            <Link
              href="/analytics"
              className="text-sm font-medium underline underline-offset-4 hover:no-underline"
            >
              Open analytics
            </Link>
          )
        }
      />

      {(orders || inventory) && (
        <Section title="Needs attention">
          <Suspense fallback={<ListSkeleton rows={3} label="Checking what needs attention" />}>
            <AttentionBlock orders={orders} inventory={inventory} />
          </Suspense>
        </Section>
      )}

      {reports && (
        <>
          <section aria-label="Last 30 days">
            <Suspense fallback={<TilesSkeleton />}>
              <SummaryBlock range={range} period="30 days" />
            </Suspense>
          </section>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <Section title="Revenue, last 30 days" className="min-w-0 lg:col-span-2">
              <Suspense fallback={<ChartSkeleton label="Loading revenue" />}>
                <RevenueBlock range={range} />
              </Suspense>
            </Section>
            <Section title="Conversion funnel" className="min-w-0">
              <Suspense fallback={<ListSkeleton rows={4} label="Loading the funnel" />}>
                <FunnelBlock range={range} compact />
              </Suspense>
            </Section>
          </div>
        </>
      )}

      {(orders || inventory) && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {orders && (
            <Section
              title="Recent orders"
              className={inventory ? "min-w-0 lg:col-span-2" : "min-w-0 lg:col-span-3"}
              actions={
                <Link
                  href="/orders"
                  className="text-sm underline underline-offset-4 hover:no-underline"
                >
                  All orders
                </Link>
              }
            >
              <Suspense fallback={<ListSkeleton rows={8} label="Loading recent orders" />}>
                <RecentOrdersBlock />
              </Suspense>
            </Section>
          )}
          {inventory && (
            <Section
              title="Low stock"
              className={orders ? "min-w-0" : "min-w-0 lg:col-span-3"}
              actions={
                <Link
                  href="/inventory?low_stock=true"
                  className="text-sm underline underline-offset-4 hover:no-underline"
                >
                  All low stock
                </Link>
              }
            >
              <Suspense fallback={<ListSkeleton rows={5} label="Loading stock levels" />}>
                <LowStockBlock />
              </Suspense>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}
