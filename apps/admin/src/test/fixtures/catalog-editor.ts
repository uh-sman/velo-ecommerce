/**
 * Fixtures for the product editor, the variant matrix and the media manager.
 * Typed against the OpenAPI schema so drift fails the type-check.
 */

import type { Schema } from "@velo/api-client";

export const PRODUCT_ID = "11111111-1111-4111-8111-111111111111";
export const VARIANT_ID = "22222222-2222-4222-8222-222222222222";
export const VARIANT_ID_2 = "22222222-2222-4222-8222-222222222223";

export function stockView(overrides: Partial<Schema<"StockView">> = {}): Schema<"StockView"> {
  return {
    allow_backorder: false,
    available: 7,
    quantity_on_hand: 9,
    quantity_reserved: 2,
    reorder_point: 5,
    track_inventory: true,
    ...overrides,
  };
}

export function variantView(
  overrides: Partial<Schema<"AdminVariantView">> = {},
): Schema<"AdminVariantView"> {
  return {
    id: VARIANT_ID,
    sku: "TEE-S",
    title: "S",
    barcode: null,
    compare_at: null,
    cost: { amount: 1000, currency: "USD" },
    price: { amount: 2500, currency: "USD" },
    is_taxable: true,
    requires_shipping: true,
    option_values: { Size: "S" },
    position: 0,
    stock: stockView(),
    weight_grams: null,
    ...overrides,
  };
}

export function mediaView(overrides: Partial<Schema<"MediaView">> = {}): Schema<"MediaView"> {
  return {
    id: "33333333-3333-4333-8333-333333333331",
    alt_text: "Front view",
    blurhash: null,
    height: 800,
    width: 800,
    media_type: "image",
    renditions: [
      { format: "webp", width: 160, height: 160, url: "https://cdn.test/a-160.webp" },
      { format: "webp", width: 320, height: 320, url: "https://cdn.test/a-320.webp" },
    ],
    url: "https://cdn.test/a.jpg",
    variant_id: null,
    ...overrides,
  };
}

export function productView(
  overrides: Partial<Schema<"AdminProductView">> = {},
): Schema<"AdminProductView"> {
  return {
    id: PRODUCT_ID,
    title: "Linen tee",
    slug: "linen-tee",
    subtitle: null,
    description: "Soft linen.",
    brand: null,
    status: "draft",
    category: null,
    collections: [],
    seo_title: null,
    seo_description: null,
    attributes: {},
    created_at: "2026-01-01T10:00:00Z",
    updated_at: "2026-01-02T10:00:00Z",
    published_at: null,
    rating_average: null,
    rating_count: 0,
    media: [],
    options: [{ name: "Size", values: [{ value: "S" }] }],
    variants: [variantView()],
    ...overrides,
  };
}

export const CATEGORIES: Schema<"AdminCategoryView">[] = [
  { id: "c1", name: "Clothing", parent_id: null, path: "clothing", position: 0, slug: "clothing" },
  { id: "c2", name: "Tops", parent_id: "c1", path: "clothing/tops", position: 0, slug: "tops" },
];

export const COLLECTIONS: Schema<"AdminCollectionView">[] = [
  {
    id: "k1",
    title: "Summer",
    slug: "summer",
    description: null,
    is_active: true,
    products: [],
  },
  {
    id: "k2",
    title: "Archive",
    slug: "archive",
    description: null,
    is_active: false,
    products: [],
  },
];
