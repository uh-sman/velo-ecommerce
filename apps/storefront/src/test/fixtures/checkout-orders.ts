/**
 * Typed fixtures for the checkout and order tests. Each builder returns a
 * complete, schema-valid object; tests override only what they exercise.
 */

import type { Schema } from "@velo/api-client";

export const usd = (amount: number): Schema<"MoneyJson"> => ({ amount, currency: "USD" });

export function makeAddressOut(overrides: Partial<Schema<"AddressOut">> = {}) {
  return {
    first_name: "Ada",
    last_name: "Lovelace",
    company: null,
    line1: "1 Market St",
    line2: null,
    city: "San Francisco",
    region: "CA",
    postal_code: "94103",
    country_code: "US",
    phone: null,
    ...overrides,
  } satisfies Schema<"AddressOut">;
}

export function makeShippingMethod(
  overrides: Partial<Schema<"ShippingMethodView">> = {},
): Schema<"ShippingMethodView"> {
  return {
    id: "rate-standard",
    name: "Standard",
    price: usd(500),
    est_days_min: 3,
    est_days_max: 5,
    ...overrides,
  };
}

export function makeCheckout(overrides: Partial<Schema<"CheckoutView">> = {}) {
  return {
    id: "chk_1",
    status: "initiated",
    email: "ada@example.com",
    currency: "USD",
    expires_at: "2026-10-02T12:30:00Z",
    order_number: null,
    payment: null,
    shipping_address: null,
    billing_address: null,
    shipping_method: null,
    discounts: [],
    warnings: [],
    items: [
      {
        variant_id: "var-1",
        product_title: "Trail Runner",
        variant_title: "Size 9",
        quantity: 2,
        sku: "TR-9",
        image_url: null,
        unit_price: usd(4500),
        line_discount: usd(0),
        line_total: usd(9000),
      },
    ],
    totals: {
      subtotal: usd(9000),
      discount: usd(0),
      shipping: null,
      tax: null,
      tax_included: null,
      total: usd(9000),
    },
    ...overrides,
  } satisfies Schema<"CheckoutView">;
}

export function makeIntent(
  overrides: Partial<Schema<"PaymentIntentView">> = {},
): Schema<"PaymentIntentView"> {
  return {
    amount: usd(9500),
    client_secret: "pi_secret_1",
    expires_at: "2026-10-02T12:30:00Z",
    payment_id: "pay_1",
    provider: "stripe",
    publishable_key: "pk_test_1",
    ...overrides,
  };
}

export function makeLine(overrides: Partial<Schema<"OrderLineView">> = {}) {
  return {
    id: "line-1",
    product_title: "Trail Runner",
    variant_title: "Size 9",
    variant_id: "var-1",
    sku: "TR-9",
    image_url: null,
    quantity: 2,
    quantity_fulfilled: 0,
    quantity_refunded: 0,
    quantity_returned: 0,
    returnable_quantity: 0,
    unit_price: usd(4500),
    discount: usd(0),
    tax: usd(0),
    total: usd(9000),
    ...overrides,
  } satisfies Schema<"OrderLineView">;
}

export function makeOrder(overrides: Partial<Schema<"OrderView">> = {}) {
  return {
    number: "VLO-ABC123",
    status: "paid",
    email: "ada@example.com",
    currency: "USD",
    placed_at: "2026-09-01T10:00:00Z",
    cancelled_at: null,
    discount_code: null,
    fulfilment_status: "unfulfilled",
    payment_status: "captured",
    can_cancel: false,
    can_return: false,
    access_token: null,
    shipping_method: "Standard",
    shipping_address: {
      first_name: "Ada",
      last_name: "Lovelace",
      line1: "1 Market St",
      city: "San Francisco",
      region: "CA",
      postal_code: "94103",
      country_code: "US",
    },
    billing_address: {},
    lines: [makeLine()],
    shipments: [],
    returns: [],
    refunds: [],
    payment: {
      provider: "stripe",
      method: "card",
      card_brand: "visa",
      card_last4: "4242",
      captured: usd(9500),
      refunded: usd(0),
    },
    totals: {
      subtotal: usd(9000),
      discount: usd(0),
      shipping: usd(500),
      tax: usd(0),
      total: usd(9500),
      refunded: usd(0),
    },
    ...overrides,
  } satisfies Schema<"OrderView">;
}

export function makeReturn(overrides: Partial<Schema<"ReturnView">> = {}): Schema<"ReturnView"> {
  return {
    id: "ret-1",
    order_id: "ord-1",
    rma_number: "RMA-0001",
    status: "requested",
    reason: "wrong_size",
    customer_note: null,
    staff_note: null,
    refund_amount: null,
    created_at: "2026-09-10T10:00:00Z",
    lines: [
      {
        order_item_id: "line-1",
        product_title: "Trail Runner",
        variant_title: "Size 9",
        sku: "TR-9",
        quantity: 1,
        condition: null,
        restock: true,
      },
    ],
    ...overrides,
  };
}

export function makeShipment(
  overrides: Partial<Schema<"ShipmentView">> = {},
): Schema<"ShipmentView"> {
  return {
    id: "shp-1",
    status: "in_transit",
    carrier: "ups",
    tracking_number: "1Z999",
    tracking_url: null,
    shipped_at: "2026-09-02T10:00:00Z",
    delivered_at: null,
    lines: [{ order_item_id: "line-1", quantity: 2 }],
    ...overrides,
  };
}
