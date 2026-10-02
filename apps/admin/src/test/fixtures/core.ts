/**
 * Fixtures for the auth, shell, settings and lib tests.
 */

import type { Schema } from "@velo/api-client";

/**
 * `refreshSession()` holds its in-flight promise until the next macrotask.
 * Await this after a test whose component refreshed, so the next test's
 * refresh is a fresh request rather than the previous answer.
 */
export function settleRefresh(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

export function taxRate(overrides: Partial<Schema<"TaxView">> = {}): Schema<"TaxView"> {
  return {
    id: "00000000-0000-4000-8000-0000000000a1",
    name: "California sales tax",
    country_code: "US",
    region: "CA",
    postal_prefix: null,
    rate: "0.0725",
    is_inclusive: false,
    priority: 0,
    is_active: true,
    ...overrides,
  };
}

export function shippingRate(overrides: Partial<Schema<"RateView">> = {}): Schema<"RateView"> {
  return {
    id: "00000000-0000-4000-8000-0000000000b1",
    zone_id: "00000000-0000-4000-8000-0000000000c1",
    name: "Standard",
    description: null,
    currency: "USD",
    price_amount: 500,
    min_subtotal_amount: null,
    max_subtotal_amount: null,
    min_weight_grams: null,
    max_weight_grams: null,
    est_days_min: null,
    est_days_max: null,
    is_active: true,
    position: 0,
    ...overrides,
  };
}

export function shippingZone(overrides: Partial<Schema<"ZoneView">> = {}): Schema<"ZoneView"> {
  return {
    id: "00000000-0000-4000-8000-0000000000c1",
    name: "Domestic",
    country_codes: ["US"],
    regions: null,
    is_active: true,
    rates: [],
    ...overrides,
  };
}

export function settings(
  overrides: {
    store?: Record<string, unknown>;
    emails?: Record<string, unknown>;
    payment_providers?: Schema<"ProviderView">[];
  } = {},
): Schema<"SettingsView"> {
  return {
    store: {
      name: "Velo Cycles",
      support_email: "help@velo.test",
      phone: "+1 555 0100",
      address: ["1 Market St", "San Francisco"],
      currency: "USD",
      return_window_days: 30,
      ...overrides.store,
    },
    emails: {
      order_confirmed_intro: "Thanks for your order!",
      order_shipped_intro: "It is on its way.",
      signature: "The Velo team",
      ...overrides.emails,
    },
    payment_providers: overrides.payment_providers ?? [
      {
        name: "stripe",
        configured: true,
        webhook_configured: true,
        mode: "live",
        currencies: ["USD", "EUR"],
        default: true,
      },
      {
        name: "paystack",
        configured: false,
        webhook_configured: false,
        mode: null,
        currencies: [],
        default: false,
      },
    ],
  };
}
