import { describe, expect, it } from "vitest";

import {
  activeFilterCount,
  apiQuery,
  readListing,
  toSearch,
  type ListingState,
} from "@/lib/listing";

const empty: ListingState = {
  sort: "newest",
  brands: [],
  min: null,
  max: null,
  inStock: false,
  cursor: null,
};

describe("listing", () => {
  it("reads URL params into a state", () => {
    expect(
      readListing({
        sort: "-price",
        brand: ["Velo", "", "Acme"],
        min: "20",
        max: ["99.5", "1"],
        in_stock: "1",
        cursor: "abc",
      }),
    ).toEqual({
      sort: "-price",
      brands: ["Velo", "Acme"],
      min: 20,
      max: 99.5,
      inStock: true,
      cursor: "abc",
    });
  });

  it("defaults anything missing or invalid", () => {
    expect(readListing({})).toEqual(empty);
    expect(readListing({ sort: "bogus", min: "-5", max: "abc", brand: "Solo" })).toEqual({
      ...empty,
      brands: ["Solo"],
    });
  });

  it("builds the API query in minor units, with only what is set", () => {
    expect(apiQuery(empty)).toEqual({ sort: "newest", limit: 24 });
    expect(
      apiQuery(
        { sort: "price", brands: ["A"], min: 19.99, max: 50, inStock: true, cursor: "c" },
        12,
      ),
    ).toEqual({
      sort: "price",
      limit: 12,
      brand: ["A"],
      min_price: 1999,
      max_price: 5000,
      in_stock: true,
      cursor: "c",
    });
  });

  it("writes a state back to a search string that reads back the same", () => {
    expect(toSearch(empty)).toBe("");
    expect(toSearch(empty, { q: "boots" })).toBe("?q=boots");
    const state: ListingState = {
      sort: "rating",
      brands: ["A", "B"],
      min: 10,
      max: 20,
      inStock: true,
      cursor: "next",
    };
    const search = toSearch(state);
    expect(search).toBe("?sort=rating&brand=A&brand=B&min=10&max=20&in_stock=1&cursor=next");
    const params = new URLSearchParams(search);
    expect(
      readListing({
        sort: params.get("sort") ?? undefined,
        brand: params.getAll("brand"),
        min: params.get("min") ?? undefined,
        max: params.get("max") ?? undefined,
        in_stock: params.get("in_stock") ?? undefined,
        cursor: params.get("cursor") ?? undefined,
      }),
    ).toEqual(state);
  });

  it("counts active filters, not sort or cursor", () => {
    expect(activeFilterCount(empty)).toBe(0);
    expect(
      activeFilterCount({
        ...empty,
        brands: ["A", "B"],
        min: 0,
        max: 5,
        inStock: true,
        cursor: "x",
      }),
    ).toBe(5);
  });
});
