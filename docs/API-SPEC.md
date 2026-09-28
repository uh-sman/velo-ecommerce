# API Specification

Base URL: `/api/v1` · Content type: `application/json` · Errors: `application/problem+json` (RFC 9457)

The live, authoritative spec is generated from the code at `/openapi.json`. This document covers conventions and the endpoint surface.

---

## 1. Conventions

### Versioning

The version is in the path: `/api/v1/...`. A breaking change means `/api/v2` alongside `v1`, with `v1` supported for at least six months and a `Sunset` header announcing the date.

**Breaking:** removing a field, renaming a field, narrowing a type, adding a required request field, changing an error code.
**Non-breaking:** adding an optional request field, adding a response field, adding an endpoint, adding an enum value the client is documented to tolerate.

### Authentication

Cookie-based. The browser sends credentials automatically; there is no `Authorization` header to leak or mishandle.

| Cookie         | Lifetime | Flags                                                 | Scope                  |
| -------------- | -------- | ----------------------------------------------------- | ---------------------- |
| `velo_access`  | 15 min   | `HttpOnly; Secure; SameSite=Lax`                      | `/`                    |
| `velo_refresh` | 30 days  | `HttpOnly; Secure; SameSite=Lax`                      | `/api/v1/auth/refresh` |
| `velo_csrf`    | session  | `Secure; SameSite=Lax` (readable by JS **by design**) | `/`                    |
| `velo_cart`    | 30 days  | `HttpOnly; Secure; SameSite=Lax`                      | `/`                    |

**CSRF:** every state-changing request (`POST`, `PATCH`, `PUT`, `DELETE`) must send `X-CSRF-Token` matching the `velo_csrf` cookie. The double-submit pattern works because an attacker's page cannot read our cookie to forge the header.

Machine clients (integrations, not browsers) use `Authorization: Bearer <api_key>` and are exempt from CSRF, since there is no ambient credential to exploit.

### Errors

RFC 9457 problem details, always. No bare strings, no inconsistent shapes.

```json
{
  "type": "https://velo.dev/errors/insufficient-stock",
  "title": "Insufficient stock",
  "status": 409,
  "detail": "Only 2 units of SKU TSHIRT-NVY-L are available.",
  "instance": "/api/v1/cart/items",
  "request_id": "01JBQX7K3M9QZ8YW2N4P6R",
  "errors": [{ "field": "quantity", "code": "exceeds_available", "message": "Maximum 2." }]
}
```

`request_id` is the correlation ID. It appears in the response, in every log line for that request, and in Sentry. A customer support ticket quoting it resolves in one query.

| Status | Meaning                                                              | Client action                                   |
| ------ | -------------------------------------------------------------------- | ----------------------------------------------- |
| 400    | Malformed request                                                    | Fix the request; do not retry as-is             |
| 401    | Not authenticated                                                    | Refresh, then re-attempt; if that fails, log in |
| 403    | Authenticated, not permitted                                         | Do not retry                                    |
| 404    | Not found, or not visible to this caller                             | Do not retry                                    |
| 409    | State conflict (stock, concurrent update, in-flight idempotency key) | Re-read state, then decide                      |
| 410    | Gone (expired checkout session)                                      | Restart the flow                                |
| 422    | Validation failed                                                    | Show field errors                               |
| 429    | Rate limited                                                         | Back off per `Retry-After`                      |
| 500    | Server fault                                                         | Retry with backoff; report `request_id`         |
| 503    | Dependency unavailable                                               | Retry per `Retry-After`                         |

**404 rather than 403 for resources the caller does not own.** Returning 403 confirms the resource exists, which leaks information. Another user's order is simply not found.

### Pagination

Cursor-based. Offset pagination is wrong for a mutating catalog: inserting a row shifts everything, so the reader silently skips or repeats items.

```http
GET /api/v1/products?limit=24&cursor=eyJpZCI6IjAxSkJRWDdLM005UVo4WVcifQ
```

```json
{
  "data": [ ... ],
  "pagination": {
    "next_cursor": "eyJpZCI6IjAxSkJRWDhMNE42UlI5WlgifQ",
    "has_more": true,
    "limit": 24
  }
}
```

`limit` defaults to 24 and caps at 100. Admin list endpoints additionally return `total_count`, since operators need it and their page sizes are small.

### Idempotency

Required on `POST /checkout`, `POST /checkout/{id}/payment-intent`, `POST /orders/{id}/refunds`.

```http
POST /api/v1/checkout/{id}/payment-intent
Idempotency-Key: <generated once per payment step, reused on every retry>
```

A replay returns the original response with `Idempotency-Replayed: true`. A missing key on a required endpoint is `400`. See [PAYMENTS-AND-CHECKOUT.md](PAYMENTS-AND-CHECKOUT.md#5-idempotency).

### Rate limits

| Class               | Limit | Window                      |
| ------------------- | ----- | --------------------------- |
| Anonymous reads     | 100   | 1 min / IP                  |
| Authenticated reads | 300   | 1 min / user                |
| Cart mutations      | 60    | 1 min / cart                |
| Login               | 5     | 15 min / IP **and** / email |
| Registration        | 3     | 1 h / IP                    |
| Password reset      | 3     | 1 h / email                 |
| Checkout creation   | 10    | 1 h / IP                    |
| Payment intent      | 10    | 1 h / session               |
| Search              | 60    | 1 min / IP                  |

Responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`; a `429` carries `Retry-After`.

Login is limited per IP _and_ per email. Per-IP alone lets a botnet spray one account; per-email alone lets one host enumerate many accounts. Both are needed.

### Money in JSON

```json
{ "price": { "amount": 2999, "currency": "USD" } }
```

Never a float, never a pre-formatted string. `amount` is minor units. The client formats for display using `Intl.NumberFormat`, which handles currencies where the minor unit is not 1/100.

---

## 2. Endpoints

### Authentication — `/auth`

| Method | Path                        | Auth           | Description                                            |
| ------ | --------------------------- | -------------- | ------------------------------------------------------ |
| POST   | `/auth/register`            | —              | Create an account; sends a verification email          |
| POST   | `/auth/login`               | —              | Sets access and refresh cookies                        |
| POST   | `/auth/refresh`             | refresh cookie | Rotates the refresh token; returns a new access cookie |
| POST   | `/auth/logout`              | access         | Revokes the refresh token server-side                  |
| POST   | `/auth/verify-email`        | —              | Consumes a single-use verification token               |
| POST   | `/auth/resend-verification` | —              | Rate limited                                           |
| POST   | `/auth/forgot-password`     | —              | Always returns 204, whether or not the email exists    |
| POST   | `/auth/reset-password`      | —              | Consumes the token; revokes all sessions               |
| GET    | `/auth/me`                  | access         | Current user                                           |
| PATCH  | `/auth/me`                  | access         | Update profile                                         |
| POST   | `/auth/change-password`     | access         | Requires the current password                          |
| GET    | `/auth/sessions`            | access         | Active sessions with device and IP                     |
| DELETE | `/auth/sessions/{id}`       | access         | Revoke one session                                     |

`POST /auth/forgot-password` returns `204` unconditionally. Returning `404` for an unknown email turns the endpoint into an account-enumeration oracle.

### Catalog — `/products`, `/collections`, `/categories`

| Method | Path                             | Auth   | Description                                                                                                                            |
| ------ | -------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/products`                      | —      | List; filter by `category`, `collection`, `min_price`, `max_price`, `in_stock`, `brand`; sort by `price`, `-price`, `newest`, `rating` |
| GET    | `/products/{slug}`               | —      | Detail with variants, options, media, availability                                                                                     |
| GET    | `/products/{slug}/related`       | —      | Related products                                                                                                                       |
| GET    | `/products/{slug}/reviews`       | —      | Approved reviews, paginated                                                                                                            |
| POST   | `/products/{slug}/reviews`       | access | Submit; verified-purchase badge if an order matches                                                                                    |
| POST   | `/products/{slug}/back-in-stock` | —      | `{variant_id, email?}` → 202. Email once when a sold-out variant is sellable again; `email` optional when signed in                    |
| GET    | `/collections`                   | —      | Active collections                                                                                                                     |
| GET    | `/collections/{slug}`            | —      | Collection with products                                                                                                               |
| GET    | `/categories`                    | —      | Full tree                                                                                                                              |
| GET    | `/categories/{slug}`             | —      | Category with products, including descendants                                                                                          |

**Example — `GET /products/merino-crew-navy`**

```json
{
  "id": "01JBQX7K3M9QZ8YW2N4P6R8T0V",
  "slug": "merino-crew-navy",
  "title": "Merino Crew Neck",
  "brand": "Northbound",
  "description": "...",
  "rating": { "average": 4.6, "count": 128 },
  "options": [
    { "name": "Size", "values": [{ "value": "S" }, { "value": "M" }, { "value": "L" }] },
    { "name": "Colour", "values": [{ "value": "Navy", "swatch_hex": "#1e293b" }] }
  ],
  "variants": [
    {
      "id": "01JBQX8L4N6RR9ZX3P5Q7S9U1W",
      "sku": "MCN-NVY-M",
      "title": "M / Navy",
      "price": { "amount": 8900, "currency": "USD" },
      "compare_at": { "amount": 11900, "currency": "USD" },
      "option_values": { "Size": "M", "Colour": "Navy" },
      "availability": { "in_stock": true, "quantity_available": 12 }
    }
  ],
  "media": [
    {
      "url": "https://cdn.../mcn-navy-1.avif",
      "alt_text": "Navy merino crew neck, front",
      "width": 1600,
      "height": 2000,
      "blurhash": "LKO2?U%2Tw=w]~RBVZRi};RPxuwH"
    }
  ],
  "seo": { "title": "Merino Crew Neck — Northbound", "description": "..." }
}
```

`quantity_available` is exposed only when it is at or below a configurable threshold (default 20). Publishing exact stock levels for everything hands competitors your sales velocity.

### Search — `/search`

| Method | Path                                                                                                         | Description                   |
| ------ | ------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| GET    | `/search?q=&brand=&category=&collection=&colour=&size=&min_price=&max_price=&in_stock=&sort=&limit=&offset=` | Full search with facet counts |
| GET    | `/search/suggest?q=`                                                                                         | Autocomplete, ≤ 8 suggestions |

Facet filters repeat for several values (`colour=Navy&colour=Olive` means either); different facets combine with AND. A category matches its descendants. `sort` is `relevance` (default), `price`, `-price`, `newest` or `rating`. Search uses offset paging, capped at 5,000 results: relevance order is not stable enough for cursors.

```json
{
  "query": "merino",
  "hits": [ ... ],
  "facets": {
    "brand":  { "Northbound": 12, "Kestrel": 4 },
    "colour": { "Navy": 8, "Charcoal": 6 },
    "size":   { "S": 14, "M": 16, "L": 15 }
  },
  "total_hits": 16,
  "limit": 24,
  "offset": 0,
  "processing_time_ms": 7,
  "degraded": false
}
```

**`degraded: true`** means Meilisearch could not answer and Postgres full-text search did (ADR-007). Results and facets are still correct; typo tolerance and synonyms are not applied. A failing engine opens a 15-second circuit breaker, so searches in that window do not wait on it. Hits carry the same card shape as `/products`; their price and stock are display hints — the product page and cart read Postgres.

### Cart — `/cart`

| Method | Path               | Auth     | Description                                                             |
| ------ | ------------------ | -------- | ----------------------------------------------------------------------- |
| GET    | `/cart`            | optional | Current cart, fully priced and validated                                |
| POST   | `/cart/items`      | optional | Add (upsert on variant)                                                 |
| PATCH  | `/cart/items/{id}` | optional | Change quantity                                                         |
| DELETE | `/cart/items/{id}` | optional | Remove                                                                  |
| DELETE | `/cart`            | optional | Empty                                                                   |
| POST   | `/cart/discount`   | optional | Apply a code                                                            |
| DELETE | `/cart/discount`   | optional | Remove the code                                                         |
| POST   | `/cart/merge`      | access   | Merge the guest cart into the user cart (called automatically on login) |

**Request — `POST /cart/items`**

```json
{ "variant_id": "01JBQX8L4N6RR9ZX3P5Q7S9U1W", "quantity": 2 }
```

A variant and a quantity. That is the entire vocabulary a client has for influencing a cart. There is no price field, no discount field, and no total field — because there is no request shape in which those could be accepted.

**Response**

```json
{
  "id": "01JBQX9M5P7SS0AY4Q6R8T0V2X",
  "currency": "USD",
  "items": [
    {
      "id": "01JBQXAN6Q8TT1BZ5R7S9U1W3Y",
      "variant": {
        "id": "...",
        "sku": "MCN-NVY-M",
        "product_title": "Merino Crew Neck",
        "variant_title": "M / Navy",
        "image_url": "https://cdn/..."
      },
      "quantity": 2,
      "unit_price": { "amount": 8900, "currency": "USD" },
      "line_total": { "amount": 17800, "currency": "USD" },
      "availability": { "in_stock": true, "max_quantity": 12 }
    }
  ],
  "discount": {
    "code": "WELCOME10",
    "title": "10% off first order",
    "amount": { "amount": 1780, "currency": "USD" }
  },
  "totals": {
    "subtotal": { "amount": 17800, "currency": "USD" },
    "discount": { "amount": 1780, "currency": "USD" },
    "shipping": null,
    "tax": null,
    "total": { "amount": 16020, "currency": "USD" }
  },
  "item_count": 2,
  "warnings": []
}
```

`shipping` and `tax` are `null` until an address is known. They are not zero — zero is a claim, `null` is the truth.

`warnings` carries non-fatal problems the customer should see: a price changed since the item was added, stock dropped below the requested quantity, a product was discontinued. The cart is never silently mutated behind the customer's back.

### Checkout — `/checkout`

| Method | Path                            | Auth     | Idempotent | Description                                         |
| ------ | ------------------------------- | -------- | ---------- | --------------------------------------------------- |
| POST   | `/checkout`                     | optional | **yes**    | Create a session from the cart; reserves stock      |
| GET    | `/checkout/{id}`                | session  | —          | Current state and totals                            |
| PATCH  | `/checkout/{id}/address`        | session  | —          | Set shipping and billing addresses                  |
| GET    | `/checkout/{id}/shipping-rates` | session  | —          | Available rates for the address                     |
| PATCH  | `/checkout/{id}/shipping`       | session  | —          | Select a rate                                       |
| POST   | `/checkout/{id}/payment-intent` | session  | **yes**    | Create the provider intent; returns `client_secret` |
| POST   | `/checkout/{id}/abandon`        | session  | —          | Release reservations early                          |

Session ownership is proven by an httpOnly cookie set at creation, so a session ID leaking through a referrer or a screenshot does not grant control of the checkout.

**Response — `POST /checkout/{id}/payment-intent`**

```json
{
  "payment_id": "01JBQXBP7R9UU2C06S8T0V2X4Z",
  "provider": "stripe",
  "client_secret": "pi_3Xy...._secret_9Ab....",
  "publishable_key": "pk_test_...",
  "amount": { "amount": 17920, "currency": "USD" },
  "expires_at": "2026-09-20T15:42:00Z"
}
```

The `amount` returned is the server's authoritative figure, recomputed from the database microseconds before the provider call. It is included so the UI can display it — not so the client can confirm it.

### Orders — `/orders`

| Method | Path                       | Auth                  | Description                          |
| ------ | -------------------------- | --------------------- | ------------------------------------ |
| GET    | `/orders`                  | access                | The caller's orders                  |
| GET    | `/orders/{number}`         | access or guest token | Order detail                         |
| POST   | `/orders/{number}/cancel`  | access                | Cancel while cancellable             |
| GET    | `/orders/{number}/invoice` | access                | Invoice PDF                          |
| POST   | `/orders/{number}/returns` | access                | Request a return                     |
| GET    | `/orders/lookup`           | —                     | Guest lookup by order number + email |

### Account — `/account`

| Method          | Path                      | Description                                                        |
| --------------- | ------------------------- | ------------------------------------------------------------------ |
| GET/POST        | `/account/addresses`      | List / create                                                      |
| PATCH/DELETE    | `/account/addresses/{id}` | Update / delete                                                    |
| GET/POST/DELETE | `/account/wishlist`       | Wishlist management                                                |
| GET/PATCH       | `/account/preferences`    | Notification preferences                                           |
| POST            | `/account/export`         | GDPR data export (async; emailed)                                  |
| DELETE          | `/account`                | GDPR erasure (anonymises; orders are retained as legally required) |

Erasure anonymises rather than deletes. Financial records must be retained for tax and audit purposes, so the user row is scrubbed of PII while orders keep a non-identifying reference. This is what GDPR Article 17(3)(b) permits, and the policy is documented in the privacy notice.

### Admin — `/admin`

All require an `admin`, `staff`, or `owner` role. Every mutation writes to `audit_log`.

| Area      | Endpoints                                                                                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Products  | `GET/POST /admin/products`, `GET/PATCH/DELETE /admin/products/{id}`, `POST /admin/products/bulk-import`, `GET /admin/products/export`                                   |
| Variants  | `POST /admin/products/{id}/variants`, `PATCH/DELETE /admin/variants/{id}`                                                                                               |
| Media     | `POST /admin/media/presign`, `POST /admin/products/{id}/media`, `PATCH /admin/media/{id}`, `DELETE /admin/media/{id}`                                                   |
| Catalog   | `GET/POST /admin/categories`, `PATCH/DELETE /admin/categories/{id}`, `GET/POST /admin/collections`, `PATCH/DELETE /admin/collections/{id}`                              |
| Reviews   | `GET /admin/reviews?status=pending`, `PATCH /admin/reviews/{id}` (`approved` \| `rejected`)                                                                             |
| Inventory | `GET /admin/inventory?low_stock=&q=`, `POST /admin/inventory/{variant_id}/adjust`, `PATCH /admin/inventory/{variant_id}`, `GET /admin/inventory/{variant_id}/movements` |
| Orders    | `GET /admin/orders`, `GET /admin/orders/{id}`, `POST /admin/orders/{id}/fulfilments`, `POST /admin/orders/{id}/refunds`, `PATCH /admin/orders/{id}/notes`               |
| Returns   | `GET /admin/returns`, `PATCH /admin/returns/{id}`                                                                                                                       |
| Customers | `GET /admin/customers`, `GET /admin/customers/{id}`                                                                                                                     |
| Discounts | `GET/POST /admin/discounts`, `PATCH/DELETE /admin/discounts/{id}`                                                                                                       |
| Shipping  | `GET/POST /admin/shipping-zones`, `GET/POST /admin/shipping-rates`                                                                                                      |
| Analytics | `GET /admin/analytics/revenue`, `/orders`, `/products`, `/funnel`, `/cohorts`                                                                                           |
| Settings  | `GET/PATCH /admin/settings`                                                                                                                                             |
| Staff     | `GET /admin/staff`, `POST /admin/staff/invite`, `PATCH/DELETE /admin/staff/{id}`                                                                                        |
| Audit     | `GET /admin/audit-log`                                                                                                                                                  |

`POST /admin/inventory/{variant_id}/adjust` requires a `reason` field. Untraceable stock adjustments are how inventory ledgers stop reconciling. Operators may give `restock` or `return` (must add), `damage` or `theft` (must remove), or `adjustment` (either way, for stocktakes); `sale` and `initial` are written by the system only. An adjustment can never take stock on hand below what checkouts have reserved.

**Permissions.** Catalog reads need `admin:access`; catalog, media, collection, category and review writes need `catalog:write`; stock changes need `inventory:write` — so fulfilment staff can receive stock without editing products.

**Media upload** is three steps, and file bytes never pass through the API: `POST /admin/media/presign` returns a presigned POST whose policy makes the bucket refuse other content types and files over the size limit; the browser sends the file straight to storage; `POST /admin/products/{id}/media` with the returned `key` and required `alt_text` attaches it. The worker then writes AVIF and WebP renditions at 320–1920 px and a blurhash, which appear on the media item's `renditions`, `width`, `height` and `blurhash` within seconds.

**Bulk import** (`POST /admin/products/bulk-import?dry_run=true`) takes the CSV as the raw request body (`Content-Type: text/csv`, UTF-8, at most 5 MB or 10,000 rows) — one row per variant, in the format `GET /admin/products/export` produces. It is all or nothing: any bad row, or `dry_run=true` (the default), rolls everything back and returns the plan and every problem by row and column.

### Webhooks — `/webhooks`

| Method | Path                 | Auth                             |
| ------ | -------------------- | -------------------------------- |
| POST   | `/webhooks/stripe`   | HMAC signature over the raw body |
| POST   | `/webhooks/paystack` | HMAC signature over the raw body |
| POST   | `/webhooks/resend`   | HMAC signature over the raw body |

### System

| Method | Path            | Description                                           |
| ------ | --------------- | ----------------------------------------------------- |
| GET    | `/health`       | Liveness — process is up. Never touches dependencies. |
| GET    | `/ready`        | Readiness — Postgres and Redis reachable              |
| GET    | `/openapi.json` | OpenAPI 3.1 schema                                    |
| GET    | `/docs`         | Swagger UI (disabled in production)                   |

`/health` must not check dependencies. If it did, a brief Redis blip would make the orchestrator kill healthy API containers and turn a degradation into an outage.

---

## 3. Security requirements on every endpoint

Checked in review for every new route. Most real breaches are a missing item from this list, not a novel exploit.

1. **Authorisation is verified server-side.** Being authenticated is not being authorised. `GET /orders/{number}` confirms the order belongs to the caller — a missing ownership check here is the single most common e-commerce vulnerability in the wild.
2. **All input is validated by a Pydantic schema.** No raw `request.json()` reaching business logic.
3. **No client-supplied monetary value is ever trusted.** If a request body contains a price, it is a bug in the schema.
4. **All queries are parameterised.** No f-string SQL anywhere, no exceptions.
5. **Errors leak nothing.** No stack traces, no SQL, no internal paths in a production response body.
6. **Rate limited** according to the table above.
7. **Mutations are audited** where an operator performed them.
8. **Unknown fields are rejected**, not silently ignored (`model_config = ConfigDict(extra="forbid")`), so a typo in a client is a loud 422 rather than a quiet no-op.

---

## 4. The generated client

`pnpm generate:api` reads `/openapi.json` and emits `packages/api-client`:

```ts
import { api } from "@velo/api-client";

const cart = await api.cart.addItem({
  variantId: "01JBQX8L4N6RR9ZX3P5Q7S9U1W",
  quantity: 2,
});
//    ^? Cart — fully typed, generated from the live schema
```

Generation runs in CI. If the backend changes a response shape and the frontend has not been updated, the type-check fails at build time rather than at runtime in a customer's browser. The Zod schemas used by React Hook Form are generated from the same source, so client-side and server-side validation rules cannot drift apart.
