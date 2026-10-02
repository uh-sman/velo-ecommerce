import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BUILT_IN_VIEWS,
  DEFAULT_FILTERS,
  filtersFromQuery,
  filtersHref,
  readFilters,
  sameFilters,
  toListQuery,
} from "./order-filters";

afterEach(() => {
  vi.useRealTimers();
});

describe("readFilters", () => {
  it("falls back to the work queue when the URL has no filters", () => {
    expect(readFilters(new URLSearchParams())).toBe(DEFAULT_FILTERS);
    expect(readFilters(new URLSearchParams("q=%20%20&page=2"))).toBe(DEFAULT_FILTERS);
  });

  it("shows everything for all=1", () => {
    expect(readFilters(new URLSearchParams("all=1"))).toEqual({});
  });

  it("keeps known, non-blank filters, trimmed", () => {
    expect(
      readFilters(new URLSearchParams("status=paid&q=%20ada%20&min_total=500&utm=x&max_total=")),
    ).toEqual({ status: "paid", q: "ada", min_total: "500" });
  });
});

describe("filtersFromQuery", () => {
  it("narrows a stored query to known string and number filters", () => {
    expect(
      filtersFromQuery({
        status: " paid ",
        min_total: 1000,
        q: "   ",
        payment_status: true,
        unknown: "x",
      }),
    ).toEqual({ status: "paid", min_total: "1000" });
  });
});

describe("filtersHref", () => {
  it("writes filters in a stable order", () => {
    expect(filtersHref({ q: "ada", status: "paid" })).toBe("/orders?status=paid&q=ada");
  });

  it("marks an empty filter set as all orders", () => {
    expect(filtersHref({})).toBe("/orders?all=1");
    expect(filtersHref({ q: "" })).toBe("/orders?all=1");
  });
});

describe("sameFilters", () => {
  it("treats missing and empty values alike", () => {
    expect(sameFilters({ q: "" }, {})).toBe(true);
    expect(sameFilters({ status: "paid" }, { status: "paid" })).toBe(true);
    expect(sameFilters({ status: "paid" }, { status: "pending" })).toBe(false);
  });
});

describe("BUILT_IN_VIEWS", () => {
  it("offers today's orders as a local date", () => {
    vi.useFakeTimers({ now: new Date(2026, 0, 5, 9, 30) });
    const today = BUILT_IN_VIEWS.find((view) => view.id === "today");
    expect(today?.filters()).toEqual({ placed_from: "2026-01-05" });
    expect(BUILT_IN_VIEWS.find((view) => view.id === "all")?.filters()).toEqual({});
    expect(BUILT_IN_VIEWS.find((view) => view.id === "needs-fulfilment")?.filters()).toBe(
      DEFAULT_FILTERS,
    );
  });
});

describe("toListQuery", () => {
  it("maps every filter to the API's query, with day boundaries in local time", () => {
    expect(
      toListQuery(
        {
          status: "paid",
          payment_status: "refunded",
          fulfilment_status: "returned",
          q: "x".repeat(250),
          placed_from: "2026-09-01",
          placed_to: "2026-09-30",
          min_total: "0",
          max_total: "5000",
        },
        "cursor-2",
        20,
      ),
    ).toEqual({
      limit: 20,
      status: "paid",
      payment_status: "refunded",
      fulfilment_status: "returned",
      q: "x".repeat(200),
      placed_from: new Date("2026-09-01T00:00:00").toISOString(),
      placed_to: new Date("2026-09-30T23:59:59.999").toISOString(),
      min_total: 0,
      max_total: 5000,
      cursor: "cursor-2",
    });
  });

  it("drops anything the API would reject", () => {
    expect(
      toListQuery(
        {
          status: "lost",
          payment_status: "maybe",
          fulfilment_status: "",
          placed_from: "1 Sept",
          placed_to: "2026-13-45",
          min_total: "-5",
          max_total: "12.5",
        },
        null,
      ),
    ).toEqual({ limit: 50 });
  });
});
