import { formatMoney, type Schema } from "@velo/api-client";
import { ArrowDownIcon, ArrowUpIcon, MinusIcon } from "lucide-react";

import { cn } from "@/lib/utils";

import { formatCount, formatPercent } from "./format";

/*
 * Headline figures for a period, each against the previous period of the same
 * length. Direction is carried by an arrow and a word ("up", "down"), never by
 * colour alone; colour follows whether the move is good for the store.
 */

interface Delta {
  /** Signed change as shown: "12%", "4 orders". */
  text: string;
  direction: "up" | "down" | "flat" | "new";
}

function percentDelta(current: number, previous: number): Delta {
  if (previous === 0) {
    return current === 0
      ? { text: "no change", direction: "flat" }
      : { text: "none in the previous period", direction: "new" };
  }
  const ratio = (current - previous) / previous;
  if (Math.abs(ratio) < 0.0005) return { text: "no change", direction: "flat" };
  return { text: formatPercent(Math.abs(ratio)), direction: ratio > 0 ? "up" : "down" };
}

function DeltaLine({ delta, period }: { delta: Delta; period: string }) {
  const Icon =
    delta.direction === "up" ? ArrowUpIcon : delta.direction === "down" ? ArrowDownIcon : MinusIcon;
  const word = delta.direction === "up" ? "Up" : delta.direction === "down" ? "Down" : "";
  return (
    <p
      className={cn(
        "mt-1 flex items-center gap-1 text-xs",
        delta.direction === "up" && "text-success",
        delta.direction === "down" && "text-danger",
        (delta.direction === "flat" || delta.direction === "new") && "text-text-secondary",
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span>
        {word && <span className="font-medium">{word} </span>}
        {delta.text}
        <span className="text-text-secondary"> vs previous {period}</span>
      </span>
    </p>
  );
}

function Tile({
  label,
  value,
  delta,
  note,
  period,
}: {
  label: string;
  value: string;
  delta?: Delta;
  note?: string;
  period: string;
}) {
  return (
    <div className="border-border-subtle bg-surface-raised rounded-lg border p-4">
      <dt className="text-text-secondary text-sm">{label}</dt>
      <dd className="m-0">
        <span className="block text-2xl font-semibold tracking-tight">{value}</span>
        {delta ? (
          <DeltaLine delta={delta} period={period} />
        ) : (
          note && <p className="text-text-tertiary mt-1 text-xs">{note}</p>
        )}
      </dd>
    </div>
  );
}

export function StatTiles({ summary, period }: { summary: Schema<"SummaryView">; period: string }) {
  const money = (amount: number) => formatMoney({ amount, currency: summary.currency });
  const previousAov =
    summary.previous_orders > 0
      ? Math.floor(summary.previous_revenue / summary.previous_orders)
      : 0;
  return (
    <dl className="m-0 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <Tile
        label="Revenue"
        value={money(summary.revenue)}
        delta={percentDelta(summary.revenue, summary.previous_revenue)}
        period={period}
      />
      <Tile
        label="Orders"
        value={formatCount(summary.orders)}
        delta={percentDelta(summary.orders, summary.previous_orders)}
        period={period}
      />
      <Tile
        label="Average order value"
        value={summary.orders > 0 ? money(summary.average_order_value) : "—"}
        {...(summary.orders > 0 && summary.previous_orders > 0
          ? { delta: percentDelta(summary.average_order_value, previousAov) }
          : { note: summary.orders > 0 ? "No orders in the previous period" : "No orders yet" })}
        period={period}
      />
      <Tile
        label="Refunded"
        value={money(summary.refunded)}
        note="This period only, no comparison"
        period={period}
      />
      <Tile
        label="New customers"
        value={formatCount(summary.new_customers)}
        note="Accounts created, no comparison"
        period={period}
      />
    </dl>
  );
}
