/**
 * Typed fixtures for the People section (customers, discounts, staff, audit).
 * Every builder returns a complete schema object; tests override what matters.
 */

import type { Schema } from "@velo/api-client";

export const UUID_A = "3f2a1b4c-0000-4000-8000-00000000000a";
export const UUID_B = "3f2a1b4c-0000-4000-8000-00000000000b";
export const UUID_C = "3f2a1b4c-0000-4000-8000-00000000000c";

export function discountView(
  overrides: Partial<Schema<"DiscountView">> = {},
): Schema<"DiscountView"> {
  return {
    id: "d0000000-0000-4000-8000-000000000001",
    code: "SPRING20",
    title: "Spring sale",
    type: "percentage",
    value: "20.0000",
    currency: null,
    applies_to: "all",
    target_ids: [],
    customer_segment: "all",
    first_order_only: false,
    buy_quantity: null,
    get_quantity: null,
    min_subtotal_amount: null,
    max_redemptions: null,
    max_per_customer: null,
    is_stackable: false,
    is_active: true,
    starts_at: "2026-01-01T09:00:00Z",
    ends_at: null,
    status: "active",
    times_redeemed: 0,
    created_at: "2026-01-01T09:00:00Z",
    ...overrides,
  };
}

export function customerView(
  overrides: Partial<Schema<"CustomerView">> = {},
): Schema<"CustomerView"> {
  return {
    id: "c0000000-0000-4000-8000-000000000001",
    email: "ada@example.com",
    first_name: "Ada",
    last_name: "Lovelace",
    role: "customer",
    status: "active",
    marketing_opt_in: false,
    order_count: 3,
    lifetime_value: { amount: 12345, currency: "USD" },
    first_order_at: "2026-02-01T10:00:00Z",
    last_order_at: "2026-03-01T10:00:00Z",
    created_at: "2026-01-15T10:00:00Z",
    ...overrides,
  };
}

export function customerDetail(
  overrides: Partial<Schema<"CustomerDetailView">> = {},
): Schema<"CustomerDetailView"> {
  return {
    id: "c0000000-0000-4000-8000-000000000001",
    email: "ada@example.com",
    email_verified: true,
    first_name: "Ada",
    last_name: "Lovelace",
    phone: "+15550100",
    role: "customer",
    status: "active",
    marketing_opt_in: true,
    order_count: 2,
    lifetime_value: { amount: 9900, currency: "USD" },
    first_order_at: "2026-02-01T10:00:00Z",
    last_order_at: "2026-03-01T10:00:00Z",
    created_at: "2026-01-15T10:00:00Z",
    addresses: [],
    recent_orders: [],
    notes: [],
    ...overrides,
  };
}

export function note(overrides: Partial<Schema<"NoteView">> = {}): Schema<"NoteView"> {
  return {
    id: "n0000000-0000-4000-8000-000000000001",
    body: "Prefers email.",
    author_email: "owner@velo.test",
    created_at: "2026-03-02T10:00:00Z",
    ...overrides,
  };
}

export function member(overrides: Partial<Schema<"MemberView">> = {}): Schema<"MemberView"> {
  return {
    id: "u0000000-0000-4000-8000-000000000002",
    email: "sam@velo.test",
    first_name: "Sam",
    last_name: "Staff",
    role: "staff",
    status: "active",
    created_at: "2026-01-10T10:00:00Z",
    ...overrides,
  };
}

export function invitation(
  overrides: Partial<Schema<"InvitationView">> = {},
): Schema<"InvitationView"> {
  return {
    id: "i0000000-0000-4000-8000-000000000001",
    email: "new@velo.test",
    role: "fulfilment",
    created_at: "2026-03-01T10:00:00Z",
    expires_at: "2026-03-08T10:00:00Z",
    ...overrides,
  };
}

export function auditEntry(overrides: Partial<Schema<"AuditView">> = {}): Schema<"AuditView"> {
  return {
    id: "a0000000-0000-4000-8000-000000000001",
    action: "discount.updated",
    actor_email: "owner@velo.test",
    actor_id: "00000000-0000-4000-8000-000000000001",
    entity_type: "discount",
    entity_id: UUID_A,
    ip_address: "203.0.113.7",
    changes: { title: { from: "Old", to: "New" } },
    created_at: "2026-03-01T10:00:00Z",
    ...overrides,
  };
}

export function productRow(
  overrides: Partial<Schema<"AdminProductRow">> = {},
): Schema<"AdminProductRow"> {
  return {
    id: "p0000000-0000-4000-8000-000000000001",
    title: "Trail runner",
    slug: "trail-runner",
    brand: null,
    image: null,
    in_stock: true,
    price: { amount: 5000, currency: "USD" },
    status: "active",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

export function variant(
  overrides: Partial<Schema<"AdminVariantView">> = {},
): Schema<"AdminVariantView"> {
  return {
    id: "v0000000-0000-4000-8000-000000000001",
    title: "Size 9",
    sku: "TR-9",
    barcode: null,
    price: { amount: 5000, currency: "USD" },
    compare_at: null,
    cost: null,
    is_taxable: true,
    option_values: {},
    position: 0,
    requires_shipping: true,
    stock: null,
    weight_grams: null,
    ...overrides,
  };
}

export function productView(
  overrides: Partial<Schema<"AdminProductView">> = {},
): Schema<"AdminProductView"> {
  return {
    id: "p0000000-0000-4000-8000-000000000001",
    title: "Trail runner",
    slug: "trail-runner",
    subtitle: null,
    description: null,
    brand: null,
    category: null,
    collections: [],
    attributes: {},
    media: [],
    options: [],
    status: "active",
    published_at: null,
    rating_average: null,
    rating_count: 0,
    seo_title: null,
    seo_description: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    variants: [variant()],
    ...overrides,
  };
}

export function collection(
  overrides: Partial<Schema<"AdminCollectionView">> = {},
): Schema<"AdminCollectionView"> {
  return {
    id: "k0000000-0000-4000-8000-000000000001",
    title: "Summer",
    slug: "summer",
    description: null,
    is_active: true,
    products: ["p1", "p2"],
    ...overrides,
  };
}

export function preview(overrides: Partial<Schema<"PreviewView">> = {}): Schema<"PreviewView"> {
  return {
    eligible: true,
    currency: "USD",
    subtotal: 10000,
    discount: 2000,
    total: 8000,
    shipping_discounted: false,
    cart_problem: null,
    customer_problem: null,
    lines: [],
    ...overrides,
  };
}

export function cursorPage<T>(
  data: T[],
  { next = null, total = null }: { next?: string | null; total?: number | null } = {},
) {
  return {
    data,
    pagination: { has_more: next !== null, next_cursor: next, limit: 50, total_count: total },
  };
}
