import { DownloadIcon } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";

import {
  CohortBlock,
  FunnelBlock,
  RevenueBlock,
  SummaryBlock,
  TopProductsBlock,
} from "@/components/insights/blocks";
import { formatDay } from "@/components/insights/format";
import { CohortMonthsControl, RangeControls } from "@/components/insights/range-controls";
import {
  describeRange,
  isoDay,
  rangeSearch,
  resolveRange,
  windowQuery,
  type SearchParams,
} from "@/components/insights/range";
import { ChartSkeleton, ListSkeleton, TilesSkeleton } from "@/components/insights/skeletons";
import { EmptyState, PageHeader, Section } from "@/components/page";
import { getMe } from "@/lib/api-server";
import { can } from "@/lib/permissions";

export const metadata: Metadata = { title: "Analytics" };

const API_ORIGIN = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:8000";

/** A CSV download straight from the API; the browser sends the session cookie. */
function csvHref(path: string, query: Record<string, string>): string {
  return `${API_ORIGIN}/api/v1/admin/analytics/${path}?${new URLSearchParams({ ...query, format: "csv" }).toString()}`;
}

function CsvLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      download
      className="border-border-default hover:bg-surface-sunken inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm"
    >
      <DownloadIcon className="size-4" aria-hidden />
      {children}
    </a>
  );
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const me = await getMe();
  if (me === null || me === "forbidden") return null; // the layout has already handled these
  if (!can(me.permissions, "reports:read")) {
    return (
      <>
        <PageHeader title="Analytics" />
        <EmptyState title="Reports are not part of your role">
          Ask an owner if you need access.
        </EmptyState>
      </>
    );
  }

  const range = resolveRange(await searchParams);
  const key = rangeSearch(range);
  const apiWindow = windowQuery(range);
  const span = `${formatDay(range.from)} – ${formatDay(range.to)}`;
  const current = {
    preset: range.preset,
    from: range.from,
    to: range.to,
    interval: range.interval,
    months: range.months,
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Analytics"
        description={
          <>
            {span}, compared with the {describeRange(range)} before. Days are UTC days, so a
            day&apos;s figures run from midnight to midnight UTC.
          </>
        }
        actions={
          <>
            <CsvLink href={csvHref("revenue", { ...apiWindow, interval: range.interval })}>
              Revenue CSV
            </CsvLink>
            <CsvLink href={csvHref("products", { ...apiWindow, limit: "100" })}>
              Top products CSV
            </CsvLink>
          </>
        }
      />

      <RangeControls key={key} current={current} today={isoDay(new Date())} />

      <section aria-label={`Headline figures, ${span}`}>
        <Suspense key={key} fallback={<TilesSkeleton />}>
          <SummaryBlock range={range} period={describeRange(range)} />
        </Suspense>
      </section>

      <Section title={`Revenue and orders per ${range.interval}`} className="min-w-0">
        <Suspense
          key={key}
          fallback={<ChartSkeleton height={392} label="Loading revenue and orders" />}
        >
          <RevenueBlock range={range} showOrders />
        </Suspense>
      </Section>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Section title="Top products" className="min-w-0 xl:col-span-2">
          <Suspense key={key} fallback={<ListSkeleton rows={8} label="Loading top products" />}>
            <TopProductsBlock range={range} />
          </Suspense>
        </Section>
        <Section title="Conversion funnel" className="min-w-0">
          <Suspense key={key} fallback={<ListSkeleton rows={4} label="Loading the funnel" />}>
            <FunnelBlock range={range} />
          </Suspense>
        </Section>
      </div>

      <Section
        title="Retention by first-order month"
        className="min-w-0"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <CohortMonthsControl current={current} />
            <CsvLink href={csvHref("cohorts", { months: String(range.months) })}>
              Cohorts CSV
            </CsvLink>
          </div>
        }
      >
        <p className="text-text-secondary mb-3 text-sm">
          Customers (guests included, by email) grouped by the month of their first order, and the
          share who ordered again in each later month. Not affected by the date range above.
        </p>
        <Suspense key={range.months} fallback={<ListSkeleton rows={6} label="Loading cohorts" />}>
          <CohortBlock months={range.months} />
        </Suspense>
      </Section>
    </div>
  );
}
