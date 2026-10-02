/*
 * The analytics date range, held in the URL so a view can be bookmarked and
 * shared: `?range=30`, or `?range=custom&from=2026-08-01&to=2026-08-31`, plus
 * `interval` and cohort `months`. Ranges are whole UTC days because the API
 * buckets by UTC day; `to` is inclusive here and becomes the API's exclusive
 * `until` (the next midnight).
 */

import type { Interval } from "./format";

export const PRESETS = [7, 30, 90, 365] as const;
export type Preset = (typeof PRESETS)[number];
export const INTERVALS: readonly Interval[] = ["day", "week", "month"];
export const COHORT_MONTHS = [6, 12, 24] as const;

export type SearchParams = Record<string, string | string[] | undefined>;

export interface ResolvedRange {
  preset: Preset | "custom";
  /** First day, inclusive (YYYY-MM-DD, UTC). */
  from: string;
  /** Last day, inclusive (YYYY-MM-DD, UTC). */
  to: string;
  /** API `since` (ISO instant). */
  since: string;
  /** API `until` (exclusive); absent for a preset, which runs up to now. */
  until: string | undefined;
  interval: Interval;
  months: number;
  /** Days covered, for "vs the previous N days". */
  days: number;
}

const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(day: string, days: number): string {
  return isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS));
}

function validDay(value: string | undefined): value is string {
  return value !== undefined && DATE.test(value) && !Number.isNaN(Date.parse(value));
}

function defaultInterval(days: number): Interval {
  if (days > 180) return "week";
  return "day";
}

/** The last `days` UTC days, today included. */
export function presetRange(days: Preset, now = new Date()): ResolvedRange {
  const to = isoDay(now);
  const from = addDays(to, -(days - 1));
  return {
    preset: days,
    from,
    to,
    since: `${from}T00:00:00Z`,
    until: undefined,
    interval: defaultInterval(days),
    months: 6,
    days,
  };
}

export function resolveRange(params: SearchParams, now = new Date()): ResolvedRange {
  const rawRange = one(params["range"]);
  const rawInterval = one(params["interval"]);
  const rawMonths = Number(one(params["months"]));
  const months = (COHORT_MONTHS as readonly number[]).includes(rawMonths) ? rawMonths : 6;

  let range: ResolvedRange = presetRange(30, now);
  const preset = PRESETS.find((days) => String(days) === rawRange);
  if (preset !== undefined) {
    range = presetRange(preset, now);
  } else if (rawRange === "custom") {
    const from = one(params["from"]);
    const to = one(params["to"]);
    const today = isoDay(now);
    if (validDay(from) && validDay(to) && from <= to && to <= today) {
      const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;
      // The API caps a window at three years.
      if (days <= 3 * 366) {
        range = {
          preset: "custom",
          from,
          to,
          since: `${from}T00:00:00Z`,
          until: `${addDays(to, 1)}T00:00:00Z`,
          interval: defaultInterval(days),
          months,
          days,
        };
      }
    }
  }
  const interval = INTERVALS.find((value) => value === rawInterval) ?? range.interval;
  return { ...range, interval, months };
}

/** The URL query for a range — what the controls navigate to. */
export function rangeSearch(range: {
  preset: Preset | "custom";
  from: string;
  to: string;
  interval: Interval;
  months: number;
}): string {
  const query = new URLSearchParams();
  query.set("range", String(range.preset));
  if (range.preset === "custom") {
    query.set("from", range.from);
    query.set("to", range.to);
  }
  query.set("interval", range.interval);
  if (range.months !== 6) query.set("months", String(range.months));
  return query.toString();
}

/** `since`/`until` for an API call, omitting `until` when it means "now". */
export function windowQuery(range: ResolvedRange): { since: string; until?: string } {
  return range.until === undefined
    ? { since: range.since }
    : { since: range.since, until: range.until };
}

export function describeRange(range: ResolvedRange): string {
  if (range.preset === "custom") return `${String(range.days)} days`;
  return range.preset === 365 ? "12 months" : `${String(range.preset)} days`;
}
