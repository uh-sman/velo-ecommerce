/**
 * Typed fixtures for the cart, product card, product detail and review tests.
 * Every builder takes a partial override so a test states only what it is about.
 */

import type { Schema } from "@velo/api-client";

type Money = Schema<"MoneyJson">;

export function usd(amount: number): Money {
  return { amount, currency: "USD" };
}

export function media(overrides: Partial<Schema<"MediaView">> = {}): Schema<"MediaView"> {
  return {
    id: "m-1",
    url: "https://cdn.example/m-1.jpg",
    alt_text: "Front view",
    blurhash: null,
    height: 1000,
    width: 800,
    media_type: "image",
    renditions: [],
    variant_id: null,
    ...overrides,
  };
}

export function cartItem(
  overrides: Partial<Omit<Schema<"CartItemView">, "variant">> & {
    variant?: Partial<Schema<"VariantRef">>;
  } = {},
): Schema<"CartItemView"> {
  const { variant, ...rest } = overrides;
  return {
    id: "item-1",
    quantity: 1,
    purchasable: true,
    availability: { in_stock: true, max_quantity: 10 },
    compare_at: null,
    line_discount: usd(0),
    line_total: usd(4500),
    unit_price: usd(4500),
    ...rest,
    variant: {
      id: "var-1",
      image_url: "https://cdn.example/tee.jpg",
      product_slug: "trail-tee",
      product_title: "Trail Tee",
      sku: "TEE-M",
      variant_title: "Medium",
      ...variant,
    },
  };
}

export function totals(overrides: Partial<Schema<"Totals">> = {}): Schema<"Totals"> {
  return {
    subtotal: usd(4500),
    discount: usd(0),
    shipping: null,
    tax: null,
    tax_included: null,
    total: usd(4500),
    ...overrides,
  };
}

export function cart(overrides: Partial<Schema<"CartView">> = {}): Schema<"CartView"> {
  const items = overrides.items ?? [cartItem()];
  return {
    id: "cart-1",
    currency: "USD",
    discount: null,
    discount_code: null,
    discounts: [],
    item_count: items.reduce((sum, item) => sum + item.quantity, 0),
    items,
    shipping: null,
    totals: totals(),
    warnings: [],
    ...overrides,
  };
}

export function productCard(overrides: Partial<Schema<"ProductCard">> = {}): Schema<"ProductCard"> {
  return {
    id: "prod-1",
    slug: "trail-tee",
    title: "Trail Tee",
    subtitle: null,
    brand: "Velo",
    image: media(),
    in_stock: true,
    price: usd(4500),
    price_max: usd(4500),
    compare_at: null,
    rating: { average: 4.5, count: 12 },
    published_at: null,
    ...overrides,
  };
}

export function variant(overrides: Partial<Schema<"VariantView">> = {}): Schema<"VariantView"> {
  return {
    id: "var-1",
    sku: "TEE-M",
    title: "Medium",
    option_values: { Size: "M" },
    price: usd(4500),
    compare_at: null,
    availability: { in_stock: true, quantity_available: 20 },
    ...overrides,
  };
}

export function product(overrides: Partial<Schema<"ProductDetail">> = {}): Schema<"ProductDetail"> {
  return {
    id: "prod-1",
    slug: "trail-tee",
    title: "Trail Tee",
    subtitle: null,
    brand: null,
    description: null,
    attributes: {},
    breadcrumbs: [],
    category: null,
    in_stock: true,
    media: [media()],
    options: [{ name: "Size", values: [{ value: "M" }] }],
    rating: null,
    seo: { title: "Trail Tee", description: null },
    variants: [variant()],
    ...overrides,
  };
}

export function review(overrides: Partial<Schema<"ReviewView">> = {}): Schema<"ReviewView"> {
  return {
    id: "rev-1",
    author: "Ada",
    body: "Fits well.",
    created_at: "2026-03-14T10:00:00Z",
    rating: 5,
    title: "Great tee",
    verified_purchase: true,
    ...overrides,
  };
}

/** jsdom has no element scrolling; the gallery calls `scrollTo` on its strip. */
export function installScrollTo(): void {
  if (!("scrollTo" in Element.prototype)) {
    Object.defineProperty(Element.prototype, "scrollTo", {
      value: () => undefined,
      configurable: true,
      writable: true,
    });
  }
}
