import { describe, expect, it } from "vitest";

import {
  formatCount,
  formatCountCompact,
  formatDay,
  formatMoneyCompact,
  formatMonth,
  formatPercent,
  formatPeriod,
  niceTicks,
} from "./format";

describe("formatMoneyCompact", () => {
  it("divides minor units by the currency's own exponent", () => {
    expect(formatMoneyCompact(480_000, "USD")).toBe("$4.8K");
    expect(formatMoneyCompact(120_000_000, "USD")).toBe("$1.2M");
    // Yen has no minor unit: 1,500,000 is ¥1.5M, not ¥15K.
    expect(formatMoneyCompact(1_500_000, "JPY")).toBe("¥1.5M");
    // Three-digit currencies divide by 1000.
    expect(formatMoneyCompact(2_000_000, "KWD")).toContain("2K");
  });

  it("formats zero", () => {
    expect(formatMoneyCompact(0, "USD")).toBe("$0");
  });
});

describe("counts and percentages", () => {
  it("groups thousands", () => {
    expect(formatCount(1_234_567)).toBe("1,234,567");
    expect(formatCount(0)).toBe("0");
  });

  it("compacts large counts to one decimal", () => {
    expect(formatCountCompact(950)).toBe("950");
    expect(formatCountCompact(1_250)).toBe("1.3K");
    expect(formatCountCompact(2_000_000)).toBe("2M");
  });

  it("formats a ratio as a percentage with up to one decimal by default", () => {
    expect(formatPercent(0.1234)).toBe("12.3%");
    expect(formatPercent(0.5)).toBe("50%");
    expect(formatPercent(1.5)).toBe("150%");
  });

  it("honours a custom number of digits", () => {
    expect(formatPercent(0.012345, 2)).toBe("1.23%");
    expect(formatPercent(0.012345, 0)).toBe("1%");
  });
});

describe("dates are UTC calendar dates", () => {
  it("labels a day bucket short, and with the year when long", () => {
    expect(formatPeriod("2026-09-03", "day")).toBe("Sep 3");
    expect(formatPeriod("2026-09-03", "day", true)).toBe("Sep 3, 2026");
  });

  it("labels a week bucket by its first day, prefixed when long", () => {
    expect(formatPeriod("2026-08-31", "week")).toBe("Aug 31");
    expect(formatPeriod("2026-08-31", "week", true)).toBe("Week of Aug 31, 2026");
  });

  it("labels a month bucket with the month and year", () => {
    expect(formatPeriod("2026-09-01", "month")).toBe("Sep 2026");
    expect(formatPeriod("2026-09-01", "month", true)).toBe("September 2026");
  });

  it("never shifts the first of the month into the previous day", () => {
    expect(formatPeriod("2026-01-01", "day", true)).toBe("Jan 1, 2026");
    expect(formatMonth("2026-01-01")).toBe("Jan 2026");
    expect(formatDay("2026-01-01")).toBe("Jan 1, 2026");
  });

  it("formats a cohort month and a single day", () => {
    expect(formatMonth("2025-12-01")).toBe("Dec 2025");
    expect(formatDay("2026-09-30")).toBe("Sep 30, 2026");
  });
});

describe("niceTicks", () => {
  it("falls back to 0..1 when there is nothing to scale", () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(-5)).toEqual([0, 1]);
    expect(niceTicks(Number.NaN)).toEqual([0, 1]);
  });

  it("steps by 1, 2, 5 or 10 times a power of ten", () => {
    expect(niceTicks(4)).toEqual([0, 1, 2, 3, 4]);
    expect(niceTicks(7)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(100)).toEqual([0, 50, 100]);
    expect(niceTicks(28)).toEqual([0, 10, 20, 30]);
    expect(niceTicks(4_800)).toEqual([0, 2_000, 4_000, 6_000]);
  });

  it("always reaches at least the maximum", () => {
    for (const max of [1, 3, 13, 99, 101, 777, 12_345]) {
      const ticks = niceTicks(max);
      expect(ticks[0]).toBe(0);
      expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(max);
    }
  });

  it("handles fractional maxima", () => {
    expect(niceTicks(1)).toEqual([0, 0.5, 1]);
  });

  it("takes a target tick count", () => {
    expect(niceTicks(100, 10)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  });
});
