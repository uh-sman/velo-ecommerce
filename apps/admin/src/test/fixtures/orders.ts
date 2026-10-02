/**
 * Fixtures for the order list, order detail, refunds, parcels and returns.
 * Typed against the OpenAPI schema so drift fails the type-check.
 *
 * The default order: two lines and $5.00 shipping, paid in full by card.
 * - Linen shirt × 3 for $30.00, nothing shipped.
 * - Canvas tote × 1 for $15.00, already shipped.
 */

import type { Schema } from "@velo/api-client";
import { vi } from "vitest";

export const ORDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const SHIRT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
export const TOTE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
export const PARCEL_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const RETURN_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
export const STAFF_ID = "00000000-0000-4000-8000-000000000001";

export function usd(amount: number): Schema<"MoneyJson"> {
  return { amount, currency: "USD" };
}

export function orderLine(
  overrides: Partial<Schema<"OrderLineView">> = {},
): Schema<"OrderLineView"> {
  return {
    id: SHIRT_ID,
    product_title: "Linen shirt",
    variant_title: "M",
    sku: "SH-M",
    image_url: null,
    variant_id: null,
    quantity: 3,
    quantity_fulfilled: 0,
    quantity_refunded: 0,
    quantity_returned: 0,
    returnable_quantity: 0,
    unit_price: usd(1000),
    discount: usd(0),
    tax: usd(0),
    total: usd(3000),
    ...overrides,
  };
}

export function toteLine(
  overrides: Partial<Schema<"OrderLineView">> = {},
): Schema<"OrderLineView"> {
  return orderLine({
    id: TOTE_ID,
    product_title: "Canvas tote",
    variant_title: "",
    sku: "TOTE",
    quantity: 1,
    quantity_fulfilled: 1,
    unit_price: usd(1500),
    total: usd(1500),
    ...overrides,
  });
}

export function adminRefund(
  overrides: Partial<Schema<"AdminRefundView">> = {},
): Schema<"AdminRefundView"> {
  return {
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1",
    actor_id: STAFF_ID,
    amount: usd(1000),
    attempts: 1,
    created_at: "2026-09-02T10:00:00Z",
    last_error: null,
    lines: [{ order_item_id: SHIRT_ID, quantity: 1, amount: 1000, restock: false }],
    note: null,
    provider_refund_id: "re_123",
    reason: "requested_by_customer",
    return_id: null,
    status: "succeeded",
    ...overrides,
  };
}

export function shipment(overrides: Partial<Schema<"ShipmentView">> = {}): Schema<"ShipmentView"> {
  return {
    id: PARCEL_ID,
    carrier: "ups",
    tracking_number: "1Z999",
    tracking_url: "https://track.example/1Z999",
    shipped_at: "2026-09-01T12:00:00Z",
    delivered_at: null,
    status: "in_transit",
    lines: [{ order_item_id: TOTE_ID, quantity: 1 }],
    ...overrides,
  };
}

export function returnView(overrides: Partial<Schema<"ReturnView">> = {}): Schema<"ReturnView"> {
  return {
    id: RETURN_ID,
    order_id: ORDER_ID,
    order_number: "VELO-1001",
    rma_number: "RMA-0001",
    status: "requested",
    reason: "wrong_size",
    created_at: "2026-09-03T09:00:00Z",
    customer_note: null,
    staff_note: null,
    refund_amount: null,
    lines: [
      {
        order_item_id: TOTE_ID,
        product_title: "Canvas tote",
        variant_title: "",
        sku: "TOTE",
        quantity: 1,
        condition: null,
        restock: false,
      },
    ],
    ...overrides,
  };
}

export function orderEvent(
  overrides: Partial<Schema<"OrderEventView">> = {},
): Schema<"OrderEventView"> {
  return {
    id: "ffffffff-ffff-4fff-8fff-fffffffffff1",
    actor_id: null,
    actor_type: "system",
    created_at: "2026-09-01T10:00:00Z",
    event_type: "created",
    from_status: null,
    to_status: "pending",
    payload: {},
    ...overrides,
  };
}

export function adminOrder(
  overrides: Partial<Schema<"AdminOrderView">> = {},
): Schema<"AdminOrderView"> {
  return {
    id: ORDER_ID,
    number: "VELO-1001",
    status: "paid",
    payment_status: "paid",
    fulfilment_status: "partially_fulfilled",
    currency: "USD",
    email: "ada@example.com",
    user_id: null,
    placed_at: "2026-09-01T10:00:00Z",
    cancelled_at: null,
    can_cancel: true,
    can_return: false,
    customer_note: null,
    internal_note: null,
    discount_code: null,
    shipping_method: "Standard",
    lines: [orderLine(), toteLine()],
    totals: {
      subtotal: usd(4500),
      discount: usd(0),
      shipping: usd(500),
      tax: usd(0),
      total: usd(5000),
      refunded: usd(0),
    },
    refundable: usd(5000),
    payment: {
      provider: "stripe",
      card_brand: "visa",
      card_last4: "4242",
      method: "card",
      captured: usd(5000),
      refunded: usd(0),
    },
    payment_reference: null,
    admin_refunds: [],
    refunds: [],
    returns: [],
    shipments: [],
    events: [],
    metadata: {},
    shipping_address: {
      first_name: "Ada",
      last_name: "Lovelace",
      line1: "1 Analytical Way",
      city: "London",
      postal_code: "N1 1AA",
      country_code: "GB",
    },
    billing_address: {
      first_name: "Ada",
      last_name: "Lovelace",
      line1: "1 Analytical Way",
      city: "London",
      postal_code: "N1 1AA",
      country_code: "GB",
    },
    ...overrides,
  };
}

export function orderRow(
  overrides: Partial<Schema<"AdminOrderSummaryView">> = {},
): Schema<"AdminOrderSummaryView"> {
  return {
    id: ORDER_ID,
    number: "VELO-1001",
    customer_name: "Ada Lovelace",
    email: "ada@example.com",
    item_count: 4,
    needs_attention: false,
    payment_status: "paid",
    fulfilment_status: "unfulfilled",
    status: "paid",
    placed_at: "2026-09-01T10:00:00Z",
    total: usd(5000),
    ...overrides,
  };
}

export function page<T>(data: T[], pagination: Partial<Schema<"PaginationInfo">> = {}) {
  return {
    data,
    pagination: {
      has_more: false,
      limit: 50,
      next_cursor: null,
      total_count: data.length,
      ...pagination,
    },
  };
}

/** A stand-in for `sonner`, so tests can assert on the toasts `notify` raises. */
export const toast = {
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
};

export const sonnerMock = { toast, Toaster: () => null };
