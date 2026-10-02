"use client";

import { formatMoney, type Schema } from "@velo/api-client";
import { useState } from "react";

import { th, td } from "@/components/page";

import {
  formatCount,
  formatCountCompact,
  formatMoneyCompact,
  formatPeriod,
  type Interval,
} from "./format";
import { TimeSeriesChart } from "./time-series-chart";

/*
 * Revenue over time, and — on the analytics page — orders beneath it on its
 * own axis (two measures, two charts; never a dual axis). The two charts share
 * the hovered bucket so they read as one figure. The numbers are always one
 * click away in "View as table".
 */
export function RevenueOverview({
  points,
  currency,
  interval,
  showOrders = false,
}: {
  points: Schema<"PointView">[];
  currency: string;
  interval: Interval;
  showOrders?: boolean;
}) {
  const [active, setActive] = useState<number | null>(null);
  const money = (amount: number) => formatMoney({ amount, currency });
  const quiet = points.every((point) => point.revenue === 0 && point.orders === 0);
  const totalRevenue = points.reduce((sum, point) => sum + point.revenue, 0);
  const totalOrders = points.reduce((sum, point) => sum + point.orders, 0);
  const span =
    points.length > 0
      ? `${formatPeriod(points[0]?.period ?? "", interval, true)} to ${formatPeriod(points[points.length - 1]?.period ?? "", interval, true)}`
      : "";

  return (
    <div className="flex flex-col gap-4">
      {quiet && (
        <p className="text-text-secondary text-sm" role="status">
          No sales in this period. Every {interval} is drawn at zero.
        </p>
      )}

      <figure className="m-0">
        <figcaption className="text-text-secondary mb-2 text-xs font-medium">
          Revenue per {interval} · {money(totalRevenue)} in total
        </figcaption>
        <TimeSeriesChart
          label={`Revenue per ${interval}, ${span}`}
          points={points.map((point) => ({ period: point.period, value: point.revenue }))}
          kind="area"
          interval={interval}
          formatValue={money}
          formatTick={(value) => formatMoneyCompact(value, currency)}
          active={active}
          onActiveChange={setActive}
        />
      </figure>

      {showOrders && (
        <figure className="m-0">
          <figcaption className="text-text-secondary mb-2 text-xs font-medium">
            Orders per {interval} · {formatCount(totalOrders)} in total
          </figcaption>
          <TimeSeriesChart
            label={`Orders per ${interval}, ${span}`}
            points={points.map((point) => ({ period: point.period, value: point.orders }))}
            kind="bars"
            interval={interval}
            formatValue={(value) => `${formatCount(value)} ${value === 1 ? "order" : "orders"}`}
            formatTick={formatCountCompact}
            height={140}
            active={active}
            onActiveChange={setActive}
          />
        </figure>
      )}

      <details className="text-sm">
        <summary className="text-text-secondary hover:text-text-primary w-fit cursor-pointer select-none">
          View as table
        </summary>
        <div className="border-border-subtle mt-2 max-h-80 overflow-auto rounded-lg border">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Revenue and orders per {interval} (UTC)</caption>
            <thead className="sticky top-0">
              <tr>
                <th scope="col" className={th}>
                  {interval === "day" ? "Day" : interval === "week" ? "Week of" : "Month"}
                </th>
                <th scope="col" className={`${th} text-right`}>
                  Revenue
                </th>
                <th scope="col" className={`${th} text-right`}>
                  Orders
                </th>
              </tr>
            </thead>
            <tbody>
              {points.map((point) => (
                <tr key={point.period}>
                  <th scope="row" className={`${td} font-normal`}>
                    {formatPeriod(point.period, interval, true)}
                  </th>
                  <td className={`${td} text-right tabular-nums`}>{money(point.revenue)}</td>
                  <td className={`${td} text-right tabular-nums`}>{formatCount(point.orders)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
