/**
 * Test-data setup through the API. Only arrangement happens here — creating
 * a discount, emptying a variant's stock, registering a customer, shipping
 * an order. What the journeys assert, they do through the UI.
 */

import { expect, request, type APIRequestContext, type APIResponse } from "@playwright/test";

import { ADMIN_EMAIL, API_URL, DEMO_PASSWORD } from "../env";

const CSRF_COOKIE = "velo_csrf";

async function ok(response: APIResponse, what: string): Promise<unknown> {
  if (!response.ok()) {
    throw new Error(`${what}: HTTP ${String(response.status())} ${await response.text()}`);
  }
  return response.status() === 204 ? null : response.json();
}

/** An API session with its own cookie jar, signed in or not. */
export class ApiSession {
  private constructor(
    private readonly context: APIRequestContext,
    private csrf: string,
  ) {}

  static async open(): Promise<ApiSession> {
    const context = await request.newContext({ baseURL: API_URL });
    const response = await context.get("/api/v1/auth/csrf");
    const { csrf_token: token } = (await ok(response, "csrf")) as { csrf_token: string };
    return new ApiSession(context, token);
  }

  static async signedIn(email: string, password: string): Promise<ApiSession> {
    const session = await ApiSession.open();
    await session.post("/api/v1/auth/login", { email, password });
    return session;
  }

  static admin(): Promise<ApiSession> {
    return ApiSession.signedIn(ADMIN_EMAIL, DEMO_PASSWORD);
  }

  private async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const state = await this.context.storageState();
    this.csrf = state.cookies.find((cookie) => cookie.name === CSRF_COOKIE)?.value ?? this.csrf;
    return { "X-CSRF-Token": this.csrf, ...extra };
  }

  async get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
    return (await ok(await this.context.get(path, { params }), `GET ${path}`)) as T;
  }

  async post<T>(path: string, data?: unknown, extra?: Record<string, string>): Promise<T> {
    const response = await this.context.post(path, {
      data: data ?? {},
      headers: await this.headers(extra),
    });
    return (await ok(response, `POST ${path}`)) as T;
  }

  async patch<T>(path: string, data: unknown): Promise<T> {
    const response = await this.context.patch(path, { data, headers: await this.headers() });
    return (await ok(response, `PATCH ${path}`)) as T;
  }

  async dispose(): Promise<void> {
    await this.context.dispose();
  }
}

// ── Catalog ──────────────────────────────────────────────────────────────────

export interface Variant {
  id: string;
  sku: string;
  title: string;
  availability: { in_stock: boolean; quantity_available: number | null };
}

export interface Product {
  id: string;
  slug: string;
  title: string;
  variants: Variant[];
}

/**
 * A product of its own for each test, so parallel tests (and browsers) never
 * share stock, carts or prices: the catalog is walked in a fixed order and
 * `slot` picks a distinct in-stock product for every journey × browser.
 */
export async function productForSlot(slot: number): Promise<Product> {
  const api = await ApiSession.open();
  try {
    const page = await api.get<{ data: { slug: string }[] }>("/api/v1/products", { limit: 48 });
    const slugs = page.data.map((product) => product.slug).sort();
    for (let offset = 0; offset < slugs.length; offset++) {
      const slug = slugs[(slot + offset) % slugs.length];
      if (!slug) continue;
      const product = await api.get<Product>(`/api/v1/products/${slug}`);
      if (product.variants.some((variant) => variant.availability.in_stock)) return product;
    }
    throw new Error("No product in stock: is velo_e2e seeded?");
  } finally {
    await api.dispose();
  }
}

// ── Admin arrangements ───────────────────────────────────────────────────────

export interface Discount {
  id: string;
  code: string;
}

/** A percentage-off code that applies to everything, for this test only. */
export async function createPercentageCode(code: string, percent: number): Promise<Discount> {
  const admin = await ApiSession.admin();
  try {
    return await admin.post<Discount>("/api/v1/admin/discounts", {
      code,
      title: `E2E ${String(percent)}% off`,
      type: "percentage",
      value: String(percent),
      applies_to: "all",
      is_active: true,
    });
  } finally {
    await admin.dispose();
  }
}

/** Set what is available to sell of a variant to `available` units. */
export async function setAvailableStock(variant: Variant, available: number): Promise<void> {
  const admin = await ApiSession.admin();
  try {
    const page = await admin.get<{
      data: { variant_id: string; stock: { available: number } }[];
    }>("/api/v1/admin/inventory", { q: variant.sku, limit: 50 });
    const current = page.data.find((row) => row.variant_id === variant.id)?.stock.available;
    if (current === undefined) throw new Error(`No stock row for ${variant.sku}`);
    const variantId = variant.id;
    const delta = available - current;
    if (delta !== 0) {
      const result = await admin.post<{ stock: { available: number } }>(
        `/api/v1/admin/inventory/${variantId}/adjust`,
        { delta, reason: "adjustment", note: "E2E: arrange stock" },
      );
      expect(result.stock.available).toBe(available);
    }
  } finally {
    await admin.dispose();
  }
}

interface AdminOrder {
  id: string;
  number: string;
  lines: { id: string; quantity: number }[];
}

/** Ship every line of an order and mark the parcel delivered — the warehouse's part. */
export async function shipAndDeliver(orderNumber: string): Promise<void> {
  const admin = await ApiSession.admin();
  try {
    const list = await admin.get<{ data: { id: string; number: string }[] }>(
      "/api/v1/admin/orders",
      { q: orderNumber, limit: 5 },
    );
    const match = list.data.find((row) => row.number === orderNumber);
    if (!match) throw new Error(`Order ${orderNumber} not found in the admin`);
    const order = await admin.get<AdminOrder>(`/api/v1/admin/orders/${match.id}`);
    const parcel = await admin.post<{ id: string }>(
      `/api/v1/admin/orders/${order.id}/fulfilments`,
      { carrier: "UPS", tracking_number: `1ZE2E${orderNumber}`, notify_customer: false },
    );
    await admin.patch(`/api/v1/admin/fulfilments/${parcel.id}`, { status: "delivered" });
  } finally {
    await admin.dispose();
  }
}

// ── Customers ────────────────────────────────────────────────────────────────

export interface Customer {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}

export const CUSTOMER_PASSWORD = "Velo-E2E-journey-2026!";

/** Register a fresh customer, optionally with a default shipping address. */
export async function registerCustomer(
  tag: string,
  address?: Record<string, string>,
): Promise<Customer> {
  const customer: Customer = {
    email: `e2e-${tag}-${Date.now().toString(36)}@example.com`,
    password: CUSTOMER_PASSWORD,
    firstName: "Ada",
    lastName: "Lovelace",
  };
  const api = await ApiSession.open();
  try {
    await api.post("/api/v1/auth/register", {
      email: customer.email,
      password: customer.password,
      first_name: customer.firstName,
      last_name: customer.lastName,
    });
    if (address) {
      await api.post("/api/v1/account/addresses", {
        first_name: customer.firstName,
        last_name: customer.lastName,
        ...address,
        is_default_shipping: true,
        is_default_billing: true,
      });
    }
  } finally {
    await api.dispose();
  }
  return customer;
}
