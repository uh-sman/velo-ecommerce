# Architecture

How Velo Commerce is put together, why, and where it breaks.

---

## 1. Architectural style

**A layered modular monolith with a headless API, deployed as three processes.**

Not microservices. That decision deserves justification, because it is the one most often made wrong in both directions.

A store at launch has one team, one database, and a handful of transactional workflows that span several domains at once — _reserve inventory, apply discount, create order, record payment_ must be atomic. In a microservice architecture that single transaction becomes a distributed saga with compensating actions, and you have paid a very large complexity tax to solve a scaling problem you do not have.

So: **one deployable API, internally partitioned by domain, with the seams drawn where services would eventually split.** Each domain package owns its models, its service layer, and its repository. Cross-domain calls go through service interfaces, never by reaching into another domain's repository or importing its ORM models. When a domain genuinely needs to scale independently, the seam is already cut and extraction is mechanical rather than archaeological.

**The seams, in likely extraction order:** search indexing (already async via the outbox), notifications (already a worker), payments, inventory.

---

## 2. Processes

| Process        | Runtime               | Scales on           | Responsibility                                           |
| -------------- | --------------------- | ------------------- | -------------------------------------------------------- |
| **Storefront** | Node 20 / Next.js 15  | Request volume      | Server-render the shopping experience; no business logic |
| **Admin**      | Node 20 / Next.js 15  | Staff count (small) | Back-office UI; no business logic                        |
| **API**        | Python 3.12 / Uvicorn | Request volume      | All business logic. The only writer to Postgres.         |
| **Workers**    | Python 3.12 / ARQ     | Queue depth         | Email, webhook processing, indexing, scheduled jobs      |

The frontends hold **no** business rules. They render what the API tells them and collect input. Every decision about price, availability, eligibility, or permission is made server-side. This is what makes the storefront genuinely replaceable — and it is also the security model.

---

## 3. Layers inside the API

Dependencies point in exactly one direction. Nothing below reaches up.

```
┌────────────────────────────────────────────────────────────┐
│  Router          FastAPI path operations                   │
│                  HTTP concerns only: status codes, headers │
│                  Pydantic schemas in and out               │
├────────────────────────────────────────────────────────────┤
│  Service         Business logic and orchestration          │
│                  Owns the transaction boundary             │
│                  Knows nothing about HTTP                  │
├────────────────────────────────────────────────────────────┤
│  Repository      Data access                               │
│                  Returns domain objects, not ORM rows      │
│                  Knows nothing about business rules        │
├────────────────────────────────────────────────────────────┤
│  Models          SQLAlchemy ORM definitions                │
└────────────────────────────────────────────────────────────┘
```

**Rules, enforced in review and by import-linter in CI:**

1. A router never touches a repository or the ORM directly.
2. A service never imports `fastapi` — it cannot raise `HTTPException`. It raises domain exceptions that the global handler translates.
3. A repository never contains an `if` that encodes a business rule.
4. ORM model instances never escape the repository layer.
5. A domain may import another domain's **service interface**, never its repository or models.

The payoff is that the whole pricing engine, the discount rules, and every state machine are testable as plain Python — no HTTP client, no test database, microseconds per test. That is what makes exhaustive testing of the money logic affordable, and affordability is what makes it actually happen.

### Domain packages

```
domains/
├── identity/      users, auth, sessions, addresses, RBAC
├── catalog/       products, variants, categories, collections, media, reviews
├── inventory/     stock levels, movements, reservations
├── cart/          carts, line items, pricing engine
├── discounts/     discount rules, eligibility, redemption
├── shipping/      zones, rates, rate calculation
├── checkout/      checkout sessions, the checkout state machine
├── payments/      provider abstraction, intents, webhooks, refunds
├── orders/        orders, fulfilments, returns, order state machine
└── admin/         admin-only composite endpoints and reporting
```

Each contains: `router.py`, `schemas.py`, `service.py`, `repository.py`, `models.py`, `exceptions.py`.

---

## 4. Request lifecycle

A `POST /api/v1/cart/items` from the browser:

```
 1. Browser → Vercel edge → Next.js server action / route handler
 2. Next.js attaches the httpOnly auth cookie, forwards to the API
 3. CORS middleware          → origin check
 4. Correlation middleware   → generate or propagate X-Request-ID, bind to log context
 5. Rate-limit middleware    → Redis counter per IP + per account
 6. Auth dependency          → verify JWT, load user, or resolve the guest cart token
 7. Router                   → validate body with Pydantic (variant_id, quantity — no price)
 8. Service                  → BEGIN
                               • load cart FOR UPDATE
                               • check available-to-sell from inventory
                               • upsert the line item
                               • re-price the entire cart from the database
                               • apply eligible discounts
                               • recompute totals
                               COMMIT
 9. Service                  → invalidate the cart cache key in Redis
10. Router                   → serialise to the response schema
11. Response                 → 200 with the fully re-priced cart
```

Note steps 7 and 8: the client supplied a variant and a quantity. Every monetary value in the response was derived server-side from the database. There is no code path by which a client-supplied price reaches a total.

---

## 5. Data flow patterns

### 5.1 The outbox pattern

Domain events must not be lost, and must not be published for transactions that later roll back. Writing to the database and publishing to a queue are two systems — a dual write, which cannot be made atomic.

The fix: write the event to an `outbox_events` table **in the same transaction** as the state change. A relay process polls unpublished rows and dispatches them.

```
┌──────────────────── one transaction ────────────────────┐
│  INSERT INTO orders ...                                 │
│  INSERT INTO order_items ...                            │
│  UPDATE inventory_items ...                             │
│  INSERT INTO outbox_events (type='order.created', ...)  │
└─────────────────────── COMMIT ──────────────────────────┘
                            │
                   ┌────────▼────────┐
                   │  Outbox relay   │  polls unpublished rows
                   └────────┬────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
        send email   index search   emit analytics
```

If the transaction rolls back, the event vanishes with it. If the relay crashes, the event is still in the table and is delivered on restart. Consumers must be idempotent, because delivery is at-least-once.

### 5.2 Idempotency

Every state-changing POST that moves money requires an `Idempotency-Key` header.

```
request arrives with key K
  ├─ K exists and completed        → return the stored response (no re-execution)
  ├─ K exists and in-flight        → 409 Conflict, client retries later
  ├─ K exists, different payload   → 422 (key reuse with different body is a client bug)
  └─ K is new                      → insert in-flight row, execute, store response, return
```

The stored response includes the status code and body, so a replay is byte-identical to the original. Keys expire after 24 hours.

### 5.3 Caching

```
read request
  → Redis GET cache key
      hit  → return
      miss → query Postgres → SET with TTL → return

write request
  → Postgres write
  → publish invalidation event via outbox
  → relay DELETEs affected keys
```

Cached: product detail (1 h), collection listings (5 min), category tree (1 h), shipping rates (15 min).
**Never cached:** cart, checkout session, inventory availability, anything user-specific. Stale availability causes oversells; the microseconds saved are not worth it.

---

## 6. Concurrency strategy

The two places where concurrency is a correctness problem, not a performance one:

### 6.1 Inventory — pessimistic locking

```sql
BEGIN;
  SELECT quantity_on_hand, quantity_reserved
    FROM inventory_items
   WHERE variant_id = $1
     FOR UPDATE;                    -- serialises concurrent checkouts on this row

  -- available = on_hand - reserved, checked in application code
  INSERT INTO inventory_reservations (variant_id, quantity, expires_at, ...);
  UPDATE inventory_items
     SET quantity_reserved = quantity_reserved + $2
   WHERE variant_id = $1;
COMMIT;
```

Pessimistic rather than optimistic, deliberately. Optimistic concurrency retries on conflict, and under a flash-sale stampede on one SKU that degrades into a retry storm. `FOR UPDATE` serialises access to exactly the contended row and nothing else, which is the correct granularity. The `CHECK (quantity_reserved <= quantity_on_hand)` constraint means the database refuses to be wrong even if the application logic is.

### 6.2 Discount usage limits — atomic conditional update

```sql
UPDATE discounts
   SET times_redeemed = times_redeemed + 1
 WHERE id = $1
   AND (max_redemptions IS NULL OR times_redeemed < max_redemptions)
RETURNING id;
```

Zero rows returned means the limit was hit. No read-then-write race, no lock held across application logic.

---

## 7. Failure modes

Designed for, not discovered in production.

| Failure                            | Detection                                            | Behaviour                                                                                                    | Recovery                                                                   |
| ---------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| **Postgres unreachable**           | `/ready` fails                                       | API returns 503; storefront serves cached catalog read-only; checkout disabled with a clear message          | Connection pool retries with backoff; alert fires immediately              |
| **Redis unreachable**              | Health check                                         | Cache misses fall through to Postgres; rate limiting fails **open**; sessions still valid (JWT is stateless) | Reconnect with backoff. Degraded, not down.                                |
| **Meilisearch unreachable**        | Circuit breaker                                      | Search falls back to Postgres full-text; facets unavailable, results still returned                          | Reindex on recovery                                                        |
| **Stripe API slow or down**        | Timeout, circuit breaker                             | Checkout shows an honest retry message; cart and reservation preserved                                       | Circuit breaker half-opens; optionally fail over to the secondary provider |
| **Webhook never arrives**          | Reconciliation job finds a stale non-terminal intent | Job queries the provider directly and settles the order                                                      | Runs every 15 min — the primary safety net                                 |
| **Webhook arrives twice**          | Duplicate provider event ID in `payment_events`      | Second delivery acknowledged with 200 and dropped                                                            | No action needed                                                           |
| **Webhook arrives out of order**   | Event timestamp older than current state             | Handler is written as a state machine; illegal transitions ignored and logged                                | No action needed                                                           |
| **API crashes mid-checkout**       | —                                                    | Payment record already written as `pending` before the provider call                                         | Reconciliation settles it                                                  |
| **Worker down**                    | Queue depth alert                                    | Jobs accumulate in Redis, nothing is lost; emails delayed                                                    | Restart; queue drains                                                      |
| **Email provider down**            | Send failure                                         | Job retries with backoff, then dead-letters                                                                  | Manual replay tool                                                         |
| **Deploy introduces a regression** | Health check + error-rate alert                      | Automatic rollback to the previous image                                                                     | Expand/contract migrations mean the old image is always schema-compatible  |

**The principle:** never take money without recording an order, and never record an order without taking money. Every failure mode above preserves that invariant.

---

## 8. Security architecture

### Trust boundaries

```
┌─ UNTRUSTED ──────────────────────────────────────────┐
│  Browser. Every byte is hostile input.               │
│  Never trusted for: prices, totals, discounts,       │
│  stock, permissions, user identity, order status.    │
└───────────────────────┬──────────────────────────────┘
                        │ validated at the boundary
┌─ SEMI-TRUSTED ────────▼──────────────────────────────┐
│  Next.js server. Holds the session cookie and        │
│  proxies. Still not a source of truth.               │
└───────────────────────┬──────────────────────────────┘
                        │
┌─ TRUSTED ─────────────▼──────────────────────────────┐
│  FastAPI. Authorises every request. Derives every    │
│  monetary value. The only writer to Postgres.        │
└───────────────────────┬──────────────────────────────┘
                        │
┌─ TRUSTED ─────────────▼──────────────────────────────┐
│  Postgres. Final guarantor via constraints.          │
└──────────────────────────────────────────────────────┘
```

Inbound webhooks are **untrusted until the HMAC signature is verified against the raw body**. Parsing before verifying is a vulnerability, because it means you have processed attacker-controlled structure before authenticating it.

### Authentication

Access token, 15 minutes, httpOnly + Secure + SameSite=Lax cookie. Refresh token, 30 days, rotating, httpOnly, scoped to the refresh path only.

**Refresh rotation with reuse detection:** each refresh issues a new token and invalidates the old one. If an already-used token is presented, that means it was stolen — the entire token family is revoked immediately and the user is notified. This turns refresh-token theft from a persistent compromise into a single-use one that raises an alarm.

Cookies over localStorage because localStorage is readable by any XSS payload. Cookies require CSRF defence in exchange, which is a smaller and better-understood problem — handled with the double-submit cookie pattern.

### PCI-DSS scope

Card data never reaches our infrastructure. Stripe Payment Elements renders inside a Stripe-hosted iframe on a Stripe origin; the card number is transmitted browser → Stripe directly. Our server sees only a payment-intent ID and a payment-method token.

This keeps the project in **SAQ-A**, the lowest compliance burden. It is a hard architectural constraint: no endpoint may ever accept a PAN, and no log may ever contain one.

---

## 9. Scaling path

Each step taken only when measurement says the previous one is exhausted.

| Stage | Trigger                    | Action                                                                                          |
| ----- | -------------------------- | ----------------------------------------------------------------------------------------------- |
| 1     | Launch                     | Single API instance, single Postgres, Redis. Sufficient to roughly 100 orders/day.              |
| 2     | CPU-bound API              | Horizontally scale API containers. It is stateless, so this is a number change.                 |
| 3     | DB connection saturation   | PgBouncer, transaction mode                                                                     |
| 4     | Read-heavy load            | Redis caching on catalog reads. Typically a 10× reduction in DB load.                           |
| 5     | Primary still hot on reads | Read replica; route catalog and analytics reads to it                                           |
| 6     | Search latency             | Meilisearch cluster                                                                             |
| 7     | `orders` table very large  | Monthly range partitioning; detach cold partitions                                              |
| 8     | Global latency             | Multi-region API with a regional read replica per region; writes still go to the primary region |
| 9     | Genuine multi-tenancy      | Shard by tenant (Citus / Neon)                                                                  |

**Do not skip ahead.** Steps 1–4 carry a store to a volume most never reach, and each later step adds operational surface that has to be maintained forever.

---

## 10. Architecture Decision Records

Full ADRs live in `docs/adr/`. Summary:

| ADR | Decision                    | Rejected                      | Because                                                                    |
| --- | --------------------------- | ----------------------------- | -------------------------------------------------------------------------- |
| 001 | Monorepo                    | Polyrepo                      | Atomic cross-stack changes; shared types; one CI                           |
| 002 | PostgreSQL                  | MongoDB, MySQL                | ACID across multi-table commerce transactions; real constraints; row locks |
| 003 | FastAPI                     | Express, Django               | Async-native; Pydantic v2 validation; free OpenAPI → typed client          |
| 004 | Modular monolith            | Microservices                 | One team, transactional workflows; seams cut for later extraction          |
| 005 | `BIGINT` minor units        | `DECIMAL`, float              | Exact; no float drift; no ORM/JSON precision loss in transit               |
| 006 | Stripe + provider interface | Stripe-only                   | Regional coverage; avoids single-provider outage risk                      |
| 007 | Meilisearch                 | Elasticsearch, PG FTS         | Typo tolerance and facets at one-container cost                            |
| 008 | JWT in httpOnly cookies     | localStorage, server sessions | XSS-resistant; stateless; rotation gives revocation                        |
| 009 | ARQ                         | Celery                        | Async-native; shares service code without sync duplicates                  |
| 010 | Webhook-confirmed orders    | Redirect-confirmed            | Redirects are lossy and forgeable; webhooks are signed and retried         |

---

## 11. What this architecture is bad at

Stated honestly, so the limits are known before they are hit.

- **Multi-tenancy.** The schema assumes a single store. Making it SaaS means a tenant column on nearly every table plus row-level security — a significant retrofit.
- **Multi-currency pricing.** Money carries a currency code, but there is no per-region price book or FX handling. Single currency for v1.
- **Multi-warehouse.** Inventory is one location per variant. Fulfilment routing across warehouses would require a new location dimension throughout.
- **Real-time updates.** Polling and revalidation, no WebSockets. Live inventory tickers or a live order feed would need a push layer added.
- **Extreme write throughput.** A single Postgres primary handles thousands of orders per hour comfortably. Flash sales in the tens of thousands per minute would need queued write absorption ahead of the database.

None of these are accidents; each is a deliberate v1 exclusion recorded in `PLANNING.md`'s backlog. They are listed here so that when one becomes relevant, the cost is known in advance rather than discovered.
