/**
 * Typed fixtures for the account, auth, email and shell tests. Built from the
 * OpenAPI schema so a drifting response shape fails the type-check.
 */
import type { Schema } from "@velo/api-client";

export function anAddress(overrides: Partial<Schema<"AddressResponse">> = {}) {
  const address: Schema<"AddressResponse"> = {
    id: "8b4d4e36-0000-4000-8000-000000000001",
    label: "Home",
    first_name: "Ada",
    last_name: "Lovelace",
    company: null,
    line1: "1 Analytical Way",
    line2: null,
    city: "London",
    region: null,
    postal_code: "SW1A 1AA",
    country_code: "GB",
    phone: null,
    is_default_shipping: false,
    is_default_billing: false,
    created_at: "2026-01-01T10:00:00Z",
    ...overrides,
  };
  return address;
}

export function aSession(overrides: Partial<Schema<"SessionResponse">> = {}) {
  const session: Schema<"SessionResponse"> = {
    id: "5e55e55e-0000-4000-8000-000000000001",
    ip_address: "203.0.113.7",
    is_current: false,
    signed_in_at: "2026-09-01T09:00:00Z",
    last_active_at: "2026-09-30T18:30:00Z",
    user_agent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36",
    ...overrides,
  };
  return session;
}

export function aUser(overrides: Partial<Schema<"UserResponse">> = {}) {
  const user: Schema<"UserResponse"> = {
    id: "05e40000-0000-4000-8000-000000000001",
    email: "ada@example.com",
    email_verified: true,
    first_name: "Ada",
    last_name: "Lovelace",
    phone: null,
    marketing_opt_in: false,
    permissions: [],
    role: "customer",
    created_at: "2026-01-01T10:00:00Z",
    ...overrides,
  };
  return user;
}

export function aProductCard(overrides: Partial<Schema<"ProductCard">> = {}) {
  const card: Schema<"ProductCard"> = {
    id: "9c0d0000-0000-4000-8000-000000000001",
    slug: "trail-runner",
    title: "Trail Runner",
    subtitle: null,
    brand: "Velo",
    image: null,
    in_stock: true,
    price: { amount: 12000, currency: "USD" },
    price_max: { amount: 12000, currency: "USD" },
    compare_at: null,
    published_at: "2026-08-01T00:00:00Z",
    rating: null,
    ...overrides,
  };
  return card;
}

export function aSearchResult(
  hits: Schema<"ProductCard">[],
  overrides: Partial<Schema<"SearchResults">> = {},
) {
  const result: Schema<"SearchResults"> = {
    hits,
    total_hits: hits.length,
    query: "",
    limit: 6,
    offset: 0,
    facets: {},
    degraded: false,
    processing_time_ms: 1,
    ...overrides,
  };
  return result;
}

export function aCategory(
  name: string,
  children: Schema<"CategoryNode">[] = [],
): Schema<"CategoryNode"> {
  const slug = name.toLowerCase().replace(/\s+/g, "-");
  return { id: `cat-${slug}`, name, slug, children };
}
