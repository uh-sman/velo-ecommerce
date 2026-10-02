import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  describeRange,
  isoDay,
  presetRange,
  rangeSearch,
  resolveRange,
  windowQuery,
  type ResolvedRange,
} from "./range";

const NOW = new Date("2026-10-02T15:30:00Z");

describe("isoDay", () => {
  it("is the UTC calendar day", () => {
    expect(isoDay(new Date("2026-10-02T23:59:59Z"))).toBe("2026-10-02");
    expect(isoDay(new Date("2026-10-03T00:00:00Z"))).toBe("2026-10-03");
  });
});

describe("presetRange", () => {
  it("covers the last N UTC days, today included, open-ended", () => {
    expect(presetRange(7, NOW)).toEqual({
      preset: 7,
      from: "2026-09-26",
      to: "2026-10-02",
      since: "2026-09-26T00:00:00Z",
      until: undefined,
      interval: "day",
      months: 6,
      days: 7,
    });
  });

  it("buckets a year by week", () => {
    const range = presetRange(365, NOW);
    expect(range.from).toBe("2025-10-03");
    expect(range.interval).toBe("week");
  });

  it("defaults to the current time", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    expect(presetRange(30).to).toBe("2026-10-02");
    vi.useRealTimers();
  });
});

describe("resolveRange", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults to the last 30 days by day", () => {
    const range = resolveRange({});
    expect(range.preset).toBe(30);
    expect(range.from).toBe("2026-09-03");
    expect(range.to).toBe("2026-10-02");
    expect(range.interval).toBe("day");
    expect(range.months).toBe(6);
  });

  it("reads a preset, taking the first of repeated params", () => {
    expect(resolveRange({ range: "90" }).preset).toBe(90);
    expect(resolveRange({ range: ["7", "365"] }).preset).toBe(7);
  });

  it("ignores an unknown preset", () => {
    expect(resolveRange({ range: "14" }).preset).toBe(30);
  });

  it("resolves a custom range with an exclusive `until`", () => {
    const range = resolveRange({ range: "custom", from: "2026-08-01", to: "2026-08-31" });
    expect(range).toEqual({
      preset: "custom",
      from: "2026-08-01",
      to: "2026-08-31",
      since: "2026-08-01T00:00:00Z",
      until: "2026-09-01T00:00:00Z",
      interval: "day",
      months: 6,
      days: 31,
    });
  });

  it("accepts a single-day custom range ending today", () => {
    const range = resolveRange({ range: "custom", from: "2026-10-02", to: "2026-10-02" });
    expect(range.days).toBe(1);
    expect(range.until).toBe("2026-10-03T00:00:00Z");
  });

  it("buckets a long custom range by week", () => {
    const range = resolveRange({ range: "custom", from: "2026-01-01", to: "2026-09-30" });
    expect(range.preset).toBe("custom");
    expect(range.interval).toBe("week");
  });

  it.each([
    ["a missing date", { from: "2026-08-01" }],
    ["a malformed date", { from: "2026-8-1", to: "2026-08-31" }],
    ["an impossible date", { from: "2026-13-01", to: "2026-13-31" }],
    ["a start after the end", { from: "2026-09-01", to: "2026-08-01" }],
    ["an end in the future", { from: "2026-09-01", to: "2026-10-03" }],
    ["more than three years", { from: "2022-01-01", to: "2026-01-01" }],
  ])("falls back to 30 days for %s", (_, dates) => {
    const range = resolveRange({ range: "custom", ...dates });
    expect(range.preset).toBe(30);
    expect(range.until).toBeUndefined();
  });

  it("lets the URL choose the interval, ignoring unknown ones", () => {
    expect(resolveRange({ range: "365", interval: "month" }).interval).toBe("month");
    expect(resolveRange({ range: "365", interval: "year" }).interval).toBe("week");
  });

  it("reads cohort months, falling back to 6", () => {
    expect(resolveRange({ months: "12" }).months).toBe(12);
    expect(resolveRange({ months: "24" }).months).toBe(24);
    expect(resolveRange({ months: "5" }).months).toBe(6);
    expect(resolveRange({ months: "lots" }).months).toBe(6);
  });

  it("takes an explicit now", () => {
    expect(resolveRange({}, new Date("2026-01-15T00:00:00Z")).to).toBe("2026-01-15");
  });
});

describe("rangeSearch", () => {
  it("writes a preset without dates, and months only when not the default", () => {
    expect(
      rangeSearch({ preset: 30, from: "2026-09-03", to: "2026-10-02", interval: "day", months: 6 }),
    ).toBe("range=30&interval=day");
  });

  it("writes a custom range with its dates and months", () => {
    expect(
      rangeSearch({
        preset: "custom",
        from: "2026-08-01",
        to: "2026-08-31",
        interval: "week",
        months: 12,
      }),
    ).toBe("range=custom&from=2026-08-01&to=2026-08-31&interval=week&months=12");
  });

  it("round-trips through resolveRange", () => {
    const original = resolveRange(
      { range: "custom", from: "2026-08-01", to: "2026-08-31", interval: "week", months: "24" },
      NOW,
    );
    const again = resolveRange(Object.fromEntries(new URLSearchParams(rangeSearch(original))), NOW);
    expect(again).toEqual(original);
  });
});

describe("windowQuery", () => {
  it("omits `until` for a preset, which runs up to now", () => {
    expect(windowQuery(presetRange(7, NOW))).toEqual({ since: "2026-09-26T00:00:00Z" });
  });

  it("includes `until` for a custom range", () => {
    const range = resolveRange({ range: "custom", from: "2026-08-01", to: "2026-08-31" }, NOW);
    expect(windowQuery(range)).toEqual({
      since: "2026-08-01T00:00:00Z",
      until: "2026-09-01T00:00:00Z",
    });
  });
});

describe("describeRange", () => {
  const custom: ResolvedRange = {
    ...presetRange(7, NOW),
    preset: "custom",
    days: 31,
  };

  it("names presets and custom ranges", () => {
    expect(describeRange(presetRange(7, NOW))).toBe("7 days");
    expect(describeRange(presetRange(90, NOW))).toBe("90 days");
    expect(describeRange(presetRange(365, NOW))).toBe("12 months");
    expect(describeRange(custom)).toBe("31 days");
  });
});
