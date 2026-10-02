import type { paths } from "@velo/api-client";

/*
 * The order list's filters, as they live in the URL — the API's own query
 * parameter names, so a link and a saved view are the same thing (PAGE-SPECS.md
 * §3.4: "Filters live in the URL so a view can be shared"). Totals are minor
 * units; dates are the YYYY-MM-DD an operator picked, in their time zone.
 */

export const FILTER_KEYS = [
  "status",
  "payment_status",
  "fulfilment_status",
  "q",
  "placed_from",
  "placed_to",
  "min_total",
  "max_total",
] as const;

export type FilterKey = (typeof FILTER_KEYS)[number];
export type OrderFilters = Partial<Record<FilterKey, string>>;

type ListQuery = NonNullable<paths["/api/v1/admin/orders"]["get"]["parameters"]["query"]>;

export const STATUS_OPTIONS = [
  { value: "", label: "Any status" },
  { value: "pending", label: "Pending" },
  { value: "paid", label: "Confirmed" },
  { value: "processing", label: "Preparing" },
  { value: "partially_fulfilled", label: "Partly shipped" },
  { value: "fulfilled", label: "Shipped" },
  { value: "delivered", label: "Delivered" },
  { value: "cancelled", label: "Cancelled" },
  { value: "partially_refunded", label: "Partly refunded" },
  { value: "refunded", label: "Refunded" },
] as const;

export const PAYMENT_OPTIONS = [
  { value: "", label: "Any payment" },
  { value: "paid", label: "Paid" },
  { value: "pending", label: "Unpaid" },
  { value: "partially_refunded", label: "Partly refunded" },
  { value: "refunded", label: "Refunded" },
  { value: "failed", label: "Payment failed" },
] as const;

export const FULFILMENT_OPTIONS = [
  { value: "", label: "Any fulfilment" },
  { value: "unfulfilled", label: "Unfulfilled" },
  { value: "partially_fulfilled", label: "Partly shipped" },
  { value: "fulfilled", label: "Shipped" },
  { value: "returned", label: "Returned" },
] as const;

/** The work queue, not a chronological log: what an operator opens the list for. */
export const DEFAULT_FILTERS: OrderFilters = {
  payment_status: "paid",
  fulfilment_status: "unfulfilled",
};

function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export const BUILT_IN_VIEWS: { id: string; name: string; filters: () => OrderFilters }[] = [
  { id: "needs-fulfilment", name: "Needs fulfilment", filters: () => DEFAULT_FILTERS },
  { id: "unpaid", name: "Unpaid", filters: () => ({ payment_status: "pending" }) },
  { id: "refunded", name: "Refunded", filters: () => ({ payment_status: "refunded" }) },
  { id: "today", name: "Today", filters: () => ({ placed_from: today() }) },
  { id: "all", name: "All orders", filters: () => ({}) },
];

/** Filters from the URL. No filters at all (and no `all=1`) means the default work queue. */
export function readFilters(params: URLSearchParams): OrderFilters {
  const filters: OrderFilters = {};
  for (const key of FILTER_KEYS) {
    const value = params.get(key)?.trim();
    if (value) filters[key] = value;
  }
  if (Object.keys(filters).length === 0 && params.get("all") !== "1") return DEFAULT_FILTERS;
  return filters;
}

/** Anything stored as a saved view's `query`, narrowed back to known filters. */
export function filtersFromQuery(query: Record<string, unknown>): OrderFilters {
  const filters: OrderFilters = {};
  for (const key of FILTER_KEYS) {
    const value = query[key];
    if (typeof value === "string" && value.trim()) filters[key] = value.trim();
    else if (typeof value === "number") filters[key] = String(value);
  }
  return filters;
}

export function filtersHref(filters: OrderFilters): string {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  if ([...params.keys()].length === 0) params.set("all", "1");
  return `/orders?${params.toString()}`;
}

export function sameFilters(a: OrderFilters, b: OrderFilters): boolean {
  return FILTER_KEYS.every((key) => (a[key] ?? "") === (b[key] ?? ""));
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly { value: string }[]) {
  return value && allowed.some((option) => option.value === value) ? (value as T) : undefined;
}

function wholeNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** A picked day's start (or end) in the operator's own time zone, as an ISO instant. */
function dayBoundary(value: string | undefined, end: boolean): string | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T${end ? "23:59:59.999" : "00:00:00"}`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function toListQuery(filters: OrderFilters, cursor: string | null, limit = 50): ListQuery {
  const query: ListQuery = { limit };
  const status = oneOf<NonNullable<ListQuery["status"]>>(filters.status, STATUS_OPTIONS);
  if (status) query.status = status;
  const payment = oneOf<NonNullable<ListQuery["payment_status"]>>(
    filters.payment_status,
    PAYMENT_OPTIONS,
  );
  if (payment) query.payment_status = payment;
  const fulfilment = oneOf<NonNullable<ListQuery["fulfilment_status"]>>(
    filters.fulfilment_status,
    FULFILMENT_OPTIONS,
  );
  if (fulfilment) query.fulfilment_status = fulfilment;
  if (filters.q) query.q = filters.q.slice(0, 200);
  const from = dayBoundary(filters.placed_from, false);
  if (from) query.placed_from = from;
  const to = dayBoundary(filters.placed_to, true);
  if (to) query.placed_to = to;
  const min = wholeNumber(filters.min_total);
  if (min !== undefined) query.min_total = min;
  const max = wholeNumber(filters.max_total);
  if (max !== undefined) query.max_total = max;
  if (cursor) query.cursor = cursor;
  return query;
}
