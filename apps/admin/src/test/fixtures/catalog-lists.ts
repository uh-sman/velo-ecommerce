/**
 * Fixtures for the catalog list screens: inventory, products, reviews and the
 * CSV import report. Typed against the OpenAPI schema so drift fails tsc.
 */

import type { Schema } from "@velo/api-client";
import { vi } from "vitest";

import { notify } from "@/components/ui/sonner";

export function pagination(
  overrides: Partial<Schema<"PaginationInfo">> = {},
): Schema<"PaginationInfo"> {
  return { has_more: false, limit: 50, next_cursor: null, total_count: null, ...overrides };
}

export function stockView(overrides: Partial<Schema<"StockView">> = {}): Schema<"StockView"> {
  return {
    allow_backorder: false,
    available: 10,
    quantity_on_hand: 12,
    quantity_reserved: 2,
    reorder_point: 5,
    track_inventory: true,
    ...overrides,
  };
}

export function stockRow(overrides: Partial<Schema<"StockRowView">> = {}): Schema<"StockRowView"> {
  return {
    low_stock: false,
    product_id: "prod-1",
    product_title: "Trail Runner",
    sku: "TR-42",
    stock: stockView(),
    variant_id: "var-1",
    variant_title: "Size 42",
    ...overrides,
  };
}

export function movement(overrides: Partial<Schema<"MovementView">> = {}): Schema<"MovementView"> {
  return {
    actor_id: null,
    created_at: "2026-09-01T10:00:00Z",
    id: "mov-1",
    note: null,
    quantity_delta: 5,
    reason: "restock",
    reference_id: null,
    reference_type: null,
    ...overrides,
  };
}

export function productRow(
  overrides: Partial<Schema<"AdminProductRow">> = {},
): Schema<"AdminProductRow"> {
  return {
    brand: null,
    id: "prod-1",
    image: null,
    in_stock: true,
    price: { amount: 2999, currency: "USD" },
    slug: "trail-runner",
    status: "active",
    title: "Trail Runner",
    updated_at: "2026-09-01T10:00:00Z",
    ...overrides,
  };
}

export function mediaView(overrides: Partial<Schema<"MediaView">> = {}): Schema<"MediaView"> {
  return {
    alt_text: null,
    blurhash: null,
    height: 1200,
    id: "media-1",
    media_type: "image",
    renditions: [],
    url: "https://cdn.velo.test/full.jpg",
    variant_id: null,
    width: 1200,
    ...overrides,
  };
}

export function adminProduct(
  overrides: Partial<Schema<"AdminProductView">> = {},
): Schema<"AdminProductView"> {
  return {
    attributes: {},
    brand: null,
    category: null,
    collections: [],
    created_at: "2026-09-01T10:00:00Z",
    description: null,
    id: "prod-1",
    media: [],
    options: [],
    published_at: null,
    rating_average: null,
    rating_count: 0,
    seo_description: null,
    seo_title: null,
    slug: "trail-runner",
    status: "active",
    subtitle: null,
    title: "Trail Runner",
    updated_at: "2026-09-01T10:00:00Z",
    variants: [],
    ...overrides,
  };
}

export function review(
  overrides: Partial<Schema<"AdminReviewView">> = {},
): Schema<"AdminReviewView"> {
  return {
    author: "Ada",
    body: "Great grip on wet rock.",
    created_at: "2026-09-01T10:00:00Z",
    id: "rev-1",
    product_id: "prod-1",
    rating: 4,
    status: "pending",
    title: "Love them",
    user_id: null,
    verified_purchase: false,
    ...overrides,
  };
}

export function importReport(
  overrides: Partial<Schema<"ImportReport">> = {},
): Schema<"ImportReport"> {
  return {
    applied: false,
    dry_run: true,
    errors: [],
    products_created: 1,
    products_updated: 2,
    rows: 3,
    variants_created: 4,
    variants_updated: 5,
    ...overrides,
  };
}

/** Spies on every toast variant; restored by `vi.restoreAllMocks()`. */
export function spyOnToasts() {
  return {
    success: vi.spyOn(notify, "success"),
    info: vi.spyOn(notify, "info"),
    warning: vi.spyOn(notify, "warning"),
    error: vi.spyOn(notify, "error"),
  };
}

/** A promise the test resolves by hand — to observe optimistic UI mid-request. */
export function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
