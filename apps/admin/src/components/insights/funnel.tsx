import type { Schema } from "@velo/api-client";

import { formatCount, formatPercent } from "./format";
import { SERIES } from "./series";

/*
 * Carts → checkouts → payments → orders, as horizontal bars on one scale (the
 * largest step). Every count and step-to-step rate is printed beside its bar,
 * so the list itself is the accessible table: the bars only reinforce it.
 *
 * Steps are counted independently in the same window, so a later step can
 * exceed an earlier one (an order today from a cart made last month); the
 * rate is shown as it is rather than capped.
 */

const STEP_LABELS: Record<string, string> = {
  carts: "Carts created",
  checkouts: "Checkouts started",
  payments: "Payments started",
  orders: "Orders placed",
};

export function Funnel({
  steps,
  compact = false,
}: {
  steps: Schema<"FunnelView">[];
  compact?: boolean;
}) {
  const max = Math.max(0, ...steps.map((step) => step.count));
  const first = steps[0];
  const last = steps[steps.length - 1];
  const overall = first && last && first.count > 0 ? last.count / first.count : null;

  return (
    <div className="flex flex-col gap-3">
      <ol aria-label="Conversion funnel" className="m-0 flex list-none flex-col gap-1 p-0">
        {steps.map((step, index) => {
          const previous = index > 0 ? steps[index - 1] : undefined;
          const rate = previous && previous.count > 0 ? step.count / previous.count : null;
          const share = max > 0 ? step.count / max : 0;
          return (
            <li key={step.step} className="flex flex-col gap-1">
              {previous && (
                <p className="text-text-tertiary pl-1 text-xs">
                  ↓{" "}
                  {rate === null
                    ? "no rate (none at the step before)"
                    : `${formatPercent(rate)} continued`}
                </p>
              )}
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="text-text-secondary">{STEP_LABELS[step.step] ?? step.step}</span>
                <span className="font-medium tabular-nums">{formatCount(step.count)}</span>
              </div>
              <div
                aria-hidden
                className="border-border-default flex h-5 items-stretch border-l"
                style={{ height: compact ? 14 : 20 }}
              >
                {step.count > 0 && (
                  <div
                    className="rounded-r-[4px]"
                    style={{ width: `${String(Math.max(share * 100, 0.75))}%`, background: SERIES }}
                  />
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <p className="border-border-subtle border-t pt-3 text-sm">
        <span className="text-text-secondary">Carts to orders: </span>
        <span className="font-semibold">{overall === null ? "—" : formatPercent(overall, 2)}</span>
        {max === 0 && <span className="text-text-secondary"> · No carts in this period</span>}
      </p>
    </div>
  );
}
