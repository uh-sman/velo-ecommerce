/*
 * Number, money and date formatting for the insight views. Money arrives as
 * integer minor units; the divisor comes from Intl, never a hard-coded 100.
 * Analytics periods are UTC calendar dates ("2026-09-03"), so they are always
 * formatted in UTC — a local-time formatter would shift them by a day.
 */

export type Interval = "day" | "week" | "month";

const LOCALE = "en-US";

function minorDigits(currency: string): number {
  return (
    new Intl.NumberFormat(LOCALE, { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}

/** "$4.8K", "$1.2M" — for axis ticks, where exact cents are noise. */
export function formatMoneyCompact(amount: number, currency: string): string {
  return new Intl.NumberFormat(LOCALE, {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(amount / 10 ** minorDigits(currency));
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat(LOCALE).format(value);
}

export function formatCountCompact(value: number): string {
  return new Intl.NumberFormat(LOCALE, { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

/** 0.1234 → "12.3%". */
export function formatPercent(ratio: number, digits = 1): string {
  return new Intl.NumberFormat(LOCALE, {
    style: "percent",
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  }).format(ratio);
}

function utcDate(period: string): Date {
  return new Date(`${period}T00:00:00Z`);
}

/** A bucket's label: "3 Sep", "Week of 1 Sep", "Sep 2026". */
export function formatPeriod(period: string, interval: Interval, long = false): string {
  const date = utcDate(period);
  if (interval === "month") {
    return date.toLocaleDateString(LOCALE, {
      month: long ? "long" : "short",
      year: "numeric",
      timeZone: "UTC",
    });
  }
  const day = date.toLocaleDateString(LOCALE, {
    day: "numeric",
    month: "short",
    ...(long ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });
  return interval === "week" && long ? `Week of ${day}` : day;
}

/** "Sep 2026" for a cohort month. */
export function formatMonth(month: string): string {
  return utcDate(month).toLocaleDateString(LOCALE, {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "3 Sep 2026" for a YYYY-MM-DD date, in UTC. */
export function formatDay(day: string): string {
  return utcDate(day).toLocaleDateString(LOCALE, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Round, readable axis ticks from zero up to at least `max`. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const rough = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / magnitude;
  const step = (residual > 5 ? 10 : residual > 2 ? 5 : residual > 1 ? 2 : 1) * magnitude;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= top + step / 2; value += step) ticks.push(value);
  return ticks;
}
