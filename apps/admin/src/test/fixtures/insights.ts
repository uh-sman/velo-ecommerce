/**
 * Typed builders for the analytics (insights) API shapes, so a fixture that
 * drifts from the OpenAPI schema fails the type-check.
 */

import type { Schema } from "@velo/api-client";

export function summary(overrides: Partial<Schema<"SummaryView">> = {}): Schema<"SummaryView"> {
  return {
    since: "2026-09-03T00:00:00Z",
    until: "2026-10-03T00:00:00Z",
    currency: "USD",
    revenue: 480_000,
    previous_revenue: 400_000,
    orders: 40,
    previous_orders: 50,
    average_order_value: 12_000,
    refunded: 2_500,
    new_customers: 12,
    units: 90,
    ...overrides,
  };
}

export function point(
  period: string,
  revenue: number,
  orders: number,
  currency = "USD",
): Schema<"PointView"> {
  return { period, revenue, orders, currency };
}

export function topProduct(
  overrides: Partial<Schema<"TopProductView">> = {},
): Schema<"TopProductView"> {
  return {
    product_id: "11111111-1111-4111-8111-111111111111",
    slug: "trail-runner",
    title: "Trail Runner",
    units: 12,
    revenue: 120_000,
    currency: "USD",
    ...overrides,
  };
}

export function funnelSteps(
  carts: number,
  checkouts: number,
  payments: number,
  orders: number,
): Schema<"FunnelView">[] {
  return [
    { step: "carts", count: carts },
    { step: "checkouts", count: checkouts },
    { step: "payments", count: payments },
    { step: "orders", count: orders },
  ];
}

export function cohort(month: string, customers: number, retained: number[]): Schema<"CohortView"> {
  return { month, customers, retained };
}

export function pagination(
  overrides: Partial<Schema<"PaginationInfo">> = {},
): Schema<"PaginationInfo"> {
  return { has_more: false, limit: 200, next_cursor: null, ...overrides };
}

let orderSeq = 0;

export function orderSummary(
  overrides: Partial<Schema<"AdminOrderSummaryView">> = {},
): Schema<"AdminOrderSummaryView"> {
  orderSeq += 1;
  const n = String(orderSeq).padStart(4, "0");
  return {
    id: `00000000-0000-4000-8000-00000000${n}`,
    number: `VEL-${n}`,
    customer_name: "Ada Lovelace",
    email: "ada@example.com",
    status: "paid",
    payment_status: "captured",
    fulfilment_status: "unfulfilled",
    item_count: 1,
    needs_attention: false,
    placed_at: "2026-10-01T10:00:00Z",
    total: { amount: 4_999, currency: "USD" },
    ...overrides,
  };
}

export function returnRequest(overrides: Partial<Schema<"ReturnView">> = {}): Schema<"ReturnView"> {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    rma_number: "RMA-0001",
    order_id: "00000000-0000-4000-8000-000000000001",
    order_number: "VEL-0001",
    status: "requested",
    reason: "too_small",
    customer_note: null,
    staff_note: null,
    refund_amount: null,
    lines: [],
    created_at: "2026-10-01T10:00:00Z",
    ...overrides,
  };
}

export function stockRow(overrides: Partial<Schema<"StockRowView">> = {}): Schema<"StockRowView"> {
  return {
    variant_id: "33333333-3333-4333-8333-333333333333",
    product_id: "44444444-4444-4444-8444-444444444444",
    product_title: "Trail Runner",
    variant_title: "Size 42",
    sku: "TR-42",
    low_stock: true,
    stock: {
      available: 2,
      quantity_on_hand: 3,
      quantity_reserved: 1,
      reorder_point: 5,
      track_inventory: true,
      allow_backorder: false,
    },
    ...overrides,
  };
}
