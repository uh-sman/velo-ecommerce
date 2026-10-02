import type { Schema } from "@velo/api-client";

import { th, td } from "@/components/page";

import { formatCount, formatMonth, formatPercent } from "./format";
import { SERIES } from "./series";

/*
 * Monthly retention as a heatmap-style table. The printed percentage carries
 * the meaning; the cell's tint (one hue, light → dark, scaled to the largest
 * value in the grid) only reinforces it. The tint is capped at 50% so primary
 * text stays legible on it in both themes. A month that has not happened yet
 * is blank; a month that happened with nobody returning reads "0%".
 */

function tint(value: number, max: number): string | undefined {
  if (value <= 0 || max <= 0) return undefined;
  const strength = 8 + Math.round((value / max) * 42);
  return `color-mix(in oklab, ${SERIES} ${String(strength)}%, transparent)`;
}

export function CohortGrid({ cohorts }: { cohorts: Schema<"CohortView">[] }) {
  const width = Math.max(0, ...cohorts.map((cohort) => cohort.retained.length));
  const max = Math.max(0, ...cohorts.flatMap((cohort) => cohort.retained));
  const offsets = Array.from({ length: width }, (_, index) => index + 1);

  return (
    <div className="flex flex-col gap-3">
      <div className="border-border-subtle overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[32rem] border-separate border-spacing-0 text-left text-sm">
          <caption className="sr-only">
            Share of each month&apos;s new customers who ordered again 1, 2, 3… months later
          </caption>
          <thead>
            <tr>
              <th scope="col" className={th}>
                First order
              </th>
              <th scope="col" className={`${th} text-right`}>
                Customers
              </th>
              {offsets.map((offset) => (
                <th key={offset} scope="col" className={`${th} text-center`}>
                  <span aria-hidden>M{offset}</span>
                  <span className="sr-only">Month {offset}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cohorts.map((cohort) => (
              <tr key={cohort.month}>
                <th scope="row" className={`${td} whitespace-nowrap font-normal`}>
                  {formatMonth(cohort.month)}
                </th>
                <td className={`${td} text-right tabular-nums`}>{formatCount(cohort.customers)}</td>
                {offsets.map((offset) => {
                  const value = cohort.retained[offset - 1];
                  if (value === undefined) {
                    return (
                      <td key={offset} className={`${td} text-text-tertiary text-center`}>
                        <span className="sr-only">Not yet</span>
                      </td>
                    );
                  }
                  const background = cohort.customers > 0 ? tint(value, max) : undefined;
                  return (
                    <td
                      key={offset}
                      className={`${td} text-center tabular-nums`}
                      style={background ? { backgroundColor: background } : undefined}
                      title={`${formatMonth(cohort.month)} cohort, month ${String(offset)}: ${formatPercent(value)}`}
                    >
                      {cohort.customers > 0 ? formatPercent(value) : "—"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="text-text-secondary flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <span className="flex items-center gap-2">
          <span aria-hidden className="flex">
            {[0.15, 0.4, 0.7, 1].map((share) => (
              <span
                key={share}
                className="size-3.5 first:rounded-l-sm last:rounded-r-sm"
                style={{ backgroundColor: tint(share, 1) }}
              />
            ))}
          </span>
          Darker means a larger share, up to {formatPercent(max)}
        </span>
        <span>M1 is the month after the first order. Blank: that month has not happened yet.</span>
      </div>
    </div>
  );
}
