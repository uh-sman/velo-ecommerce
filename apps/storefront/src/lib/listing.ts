/**
 * Listing filters live in the URL (PLANNING.md 10.2): a filtered page can be
 * shared, bookmarked, and the back button undoes a filter. These helpers
 * translate between the URL's search params and the API's query.
 *
 * Prices are whole currency units in the URL (`?min=20`), for people; minor
 * units in the API (`min_price=2000`), for money.
 */

export type Sort = "newest" | "price" | "-price" | "rating";

export const SORTS: { value: Sort; label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "price", label: "Price: low to high" },
  { value: "-price", label: "Price: high to low" },
  { value: "rating", label: "Top rated" },
];

export interface ListingState {
  sort: Sort;
  brands: string[];
  min: number | null;
  max: number | null;
  inStock: boolean;
  cursor: string | null;
}

type Params = Record<string, string | string[] | undefined>;

function all(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).filter(Boolean);
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function amount(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function readListing(params: Params): ListingState {
  const sort = first(params["sort"]);
  return {
    sort: SORTS.some((s) => s.value === sort) ? (sort as Sort) : "newest",
    brands: all(params["brand"]),
    min: amount(first(params["min"])),
    max: amount(first(params["max"])),
    inStock: first(params["in_stock"]) === "1",
    cursor: first(params["cursor"]) ?? null,
  };
}

/** The API query for a listing: minor units, and only what is set. */
export function apiQuery(state: ListingState, limit = 24) {
  return {
    sort: state.sort,
    limit,
    ...(state.brands.length ? { brand: state.brands } : {}),
    ...(state.min !== null ? { min_price: Math.round(state.min * 100) } : {}),
    ...(state.max !== null ? { max_price: Math.round(state.max * 100) } : {}),
    ...(state.inStock ? { in_stock: true } : {}),
    ...(state.cursor ? { cursor: state.cursor } : {}),
  };
}

/** The URL search string for a state — the inverse of readListing. */
export function toSearch(state: ListingState, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra);
  if (state.sort !== "newest") params.set("sort", state.sort);
  for (const brand of state.brands) params.append("brand", brand);
  if (state.min !== null) params.set("min", String(state.min));
  if (state.max !== null) params.set("max", String(state.max));
  if (state.inStock) params.set("in_stock", "1");
  if (state.cursor) params.set("cursor", state.cursor);
  const text = params.toString();
  return text ? `?${text}` : "";
}

export function activeFilterCount(state: ListingState): number {
  return (
    state.brands.length +
    (state.min !== null ? 1 : 0) +
    (state.max !== null ? 1 : 0) +
    (state.inStock ? 1 : 0)
  );
}
