# Velo Commerce

A production-grade, headless e-commerce platform. **PostgreSQL + FastAPI + Next.js.**

![Status](https://img.shields.io/badge/status-planning-blue)
![Backend](https://img.shields.io/badge/backend-FastAPI%20%7C%20Python%203.12-009688)
![Frontend](https://img.shields.io/badge/frontend-Next.js%2015%20%7C%20React%2019-black)
![Database](https://img.shields.io/badge/database-PostgreSQL%2016-336791)
![License](https://img.shields.io/badge/license-MIT-green)

---

## Table of contents

- [What this application does](#what-this-application-does)
- [The problem it solves](#the-problem-it-solves)
- [Why I built it](#why-i-built-it--a-developers-rationale)
- [A note on "PERN"](#a-note-on-pern)
- [Feature set](#feature-set)
- [Architecture at a glance](#architecture-at-a-glance)
- [Technology choices and why](#technology-choices-and-why)
- [Why PostgreSQL](#why-postgresql--and-how-it-stays-fast-at-scale)
- [Repository layout](#repository-layout)
- [Getting started](#getting-started)
- [Environment variables](#environment-variables)
- [Common commands](#common-commands)
- [Testing](#testing)
- [Deployment](#deployment)
- [Documentation map](#documentation-map)
- [Project status](#project-status)

---

## What this application does

Velo Commerce is a complete, self-hostable online store. It ships as three deployable pieces that share one database and one API:

1. **Storefront** — the public shopping experience. Customers browse collections, filter and search a catalog, read product detail pages with variant selection and real stock levels, build a cart, and complete a checkout that accepts real card payments.
2. **Admin dashboard** — the operator's back office. Staff create and edit products and variants, manage inventory, build discount campaigns, process and fulfil orders, issue refunds, manage customers, and read sales analytics.
3. **API** — a headless, versioned, OpenAPI-documented HTTP API that both of the above consume, and that a mobile app, a kiosk, or a marketplace integration could consume equally well.

Concretely, the system handles the full commercial lifecycle:

**Browse → Search → Cart → Checkout → Payment → Order → Fulfilment → Delivery → Return/Refund**

Every one of those transitions is modelled explicitly in the database, guarded by server-side validation, and recorded in an immutable audit trail.

### The five things it does that matter most

| Capability                       | What it actually means                                                                                                                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Server-authoritative pricing** | The browser never decides what anything costs. The cart is re-priced on the server on every mutation, and again immediately before payment capture. A tampered client cannot buy a $900 item for $9. |
| **Oversell-proof inventory**     | Stock is _reserved_ (not just checked) when checkout begins, with a TTL. Two people racing for the last unit produce one order and one honest "out of stock", not two orders and an angry email.     |
| **Idempotent payments**          | Every write that moves money carries an idempotency key. A double-clicked "Pay" button, a retried mobile request, or a duplicated Stripe webhook results in exactly one charge and one order.        |
| **Webhook-confirmed orders**     | An order is only marked paid when the payment provider's signed webhook says so — never on a client-side redirect, which a user can fake and a flaky network can lose.                               |
| **Accessible, fast storefront**  | Server-rendered product pages, WCAG 2.1 AA compliance, Core Web Vitals budgets enforced in CI. A store nobody can use on a mid-range Android on 3G is not a store.                                   |

---

## The problem it solves

### The business problem

A merchant who wants to sell online today faces three bad options:

**Option 1 — Hosted SaaS (Shopify, BigCommerce).** Fast to launch, but you rent your own store. You pay a percentage of every sale on top of payment processing, you are limited to what the theme system and app ecosystem allow, your customer data lives in someone else's account, and migrating off becomes harder every month. For a merchant doing meaningful volume, the platform fee alone can exceed the cost of an engineer.

**Option 2 — A legacy open-source monolith (WooCommerce, Magento).** You own it, but you inherit a plugin-coupled PHP monolith with an admin panel welded to the storefront. Custom frontends are a fight. Performance degrades as the catalog grows. Security patching is a permanent tax.

**Option 3 — Build from scratch.** Full control, and roughly six months before you can take a payment safely — because the hard parts of commerce are not the product grid. They are concurrency, money, and trust.

Velo Commerce is option four: **the correctness-critical 80% of a store, already built and tested, with a decoupled frontend you can replace entirely without touching the business logic.**

### The engineering problem

Most e-commerce tutorials produce code that would lose money in production. The failure modes are well-known and nearly universal:

| Common failure                                  | Consequence                                                    | How Velo prevents it                                                                   |
| ----------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Prices sent from the client and trusted         | Customer edits the request, buys at any price                  | Server re-prices every cart mutation; totals recomputed before capture                 |
| Money stored as `FLOAT`                         | `0.1 + 0.2 = 0.30000000000000004`; accounts drift, audits fail | All money is `BIGINT` in minor units (cents) with an explicit ISO-4217 currency column |
| Stock decremented after payment                 | Two customers, one unit, two successful orders                 | Reservation rows written inside the checkout transaction with `SELECT ... FOR UPDATE`  |
| Order created on redirect back from the gateway | User closes the tab; money taken, no order exists              | Order finalisation driven by signed provider webhooks, plus a reconciliation sweep     |
| No idempotency on payment endpoints             | Retry or double-click = double charge                          | `idempotency_keys` table; replays return the original response                         |
| Webhooks processed without signature checks     | Anyone who knows the URL can mark orders paid for free         | HMAC signature verified against the raw request body before parsing                    |
| Refunds computed by hand                        | Over-refund past the captured amount                           | Refunds validated against the capture ledger; partial refunds tracked per line item    |
| Product prices read live at fulfilment time     | A price change silently rewrites a historical order            | Line items snapshot price, tax rate, and product title at purchase                     |

Velo Commerce exists so those problems are solved once, in one place, with tests that prove it — instead of being rediscovered by every team that builds a store.

### Who it is for

- **Merchants** outgrowing hosted SaaS who want to stop paying a revenue share and own their data.
- **Agencies** who need a dependable commerce backend they can put any bespoke frontend on top of.
- **Engineers** who want a reference implementation of commerce done carefully — the concurrency, the money handling, the payment state machine.

---

## Why I built it — a developer's rationale

I have shipped enough payment integrations to believe that **the hard part of e-commerce is not the UI. It is being correct about money under concurrency.**

The product grid is an afternoon. The interesting work is what happens when two customers hit "Buy" on the last unit in the same 40 milliseconds; when Stripe delivers the same webhook three times because the first `200` was slow; when a customer's card succeeds but the database connection drops before the order row is written; or when someone opens DevTools and edits the price in the request body. Those are the moments that decide whether a store is a business or a liability — and they are precisely the moments most codebases handle by accident.

So I built this around four commitments:

**1. The server is the only source of truth about money.** The client renders prices; it never states them. Every total is derived server-side from the database at the moment it matters. This single rule eliminates an entire family of exploits.

**2. Every money-moving operation is idempotent and auditable.** Retries are a fact of distributed systems, not an edge case. Payments, refunds, and inventory movements all carry idempotency keys and write to an append-only ledger. Given any order, I can reconstruct exactly what happened and when.

**3. Failure is designed for, not patched around.** The payment provider will be slow. Webhooks will arrive twice, out of order, or not at all. The reconciliation job that sweeps for stranded payment intents is not a nice-to-have — it is the difference between a support ticket and a chargeback.

**4. The frontend is genuinely replaceable.** A headless API with a typed client means the storefront is a consumer, not a component. Rebuild it in anything; the commerce logic is untouched. That is what "headless" has to mean to be worth the added indirection.

And a fifth commitment that is about craft rather than correctness: **the storefront should be beautiful and effortless.** Conversion is a design problem, and checkout friction is measured in abandoned revenue. So the design system is defined up front — type scale, spacing rhythm, motion, dark mode, focus states — rather than bolted on at the end, and accessibility is a build-time gate, not a retrofit.

This project is my answer to the question _"what does it actually take to build a store you would trust with someone else's money?"_ — written down, tested, and documented well enough that someone else can pick it up.

---

## A note on "PERN"

This project was requested as a "PERN" stack (PostgreSQL, Express, React, Node) built with **FastAPI and Next.js**. Those two requirements are in direct conflict: PERN's "E" and "N" _are_ the Express/Node API layer, and FastAPI _is_ the API layer. A project cannot have both without running two redundant backends.

**The resolution used here** keeps the intent of PERN — a relational Postgres core behind a React frontend — and swaps the API runtime:

| PERN           | Velo Commerce               | Why                                                 |
| -------------- | --------------------------- | --------------------------------------------------- |
| **P**ostgreSQL | **P**ostgreSQL 16           | Unchanged. Still the right answer.                  |
| **E**xpress    | **F**astAPI                 | Explicitly requested. Async, typed, OpenAPI-native. |
| **R**eact      | **R**eact 19 via Next.js 15 | Unchanged, with SSR/RSC on top.                     |
| **N**ode       | **N**ode 20                 | Still present — it runs Next.js. Just not the API.  |

So: **PostgreSQL, FastAPI, React, Node.** Same architectural shape, Python API tier. Node has not disappeared; it renders the frontend. If you specifically need Express endpoints, that is a different architecture and the plan would change materially — say so and I will revise it.

---

## Feature set

### Storefront

- Home page with merchandised collections and editorial blocks
- Category and collection pages with faceted filtering (price, size, colour, brand, availability) and sorting
- Instant search with typo tolerance, synonyms, and suggestions (Meilisearch)
- Product detail pages: image gallery with zoom, variant matrix selection, live stock indication, related products, reviews
- Persistent cart for guests (cookie-bound) that merges into the account cart on login
- Multi-step checkout: contact → shipping address → shipping method → payment → review
- Guest checkout (no forced account creation)
- Discount codes, automatic promotions, free-shipping thresholds
- Address book, saved payment methods, order history, order tracking, self-service returns
- Wishlist, recently viewed, back-in-stock notifications
- Full dark mode, responsive from 320px, WCAG 2.1 AA

### Checkout and payments

- Stripe Payment Elements (cards, Apple Pay, Google Pay, Link) — **card data never touches our servers** (PCI-DSS SAQ-A scope)
- Pluggable payment-provider interface with a second adapter for Paystack/Flutterwave (African card, bank transfer, USSD, mobile money)
- 3-D Secure / SCA handled inside the provider's hosted element
- Idempotent payment-intent creation and capture
- Signed webhook ingestion with replay protection and a dead-letter queue
- Inventory reservation with TTL, released automatically on abandonment
- Tax calculation (configurable rules; pluggable for Stripe Tax or a regional provider)
- Shipping rate engine: flat, weight-banded, price-banded, free-over-threshold, per-zone
- Full and partial refunds, per line item, validated against the capture ledger
- Abandoned-cart recovery emails

### Admin

- Product and variant CRUD with bulk CSV import/export
- Media library with S3/R2 upload and automatic responsive derivatives
- Inventory management with movement history and low-stock alerts
- Order pipeline: pending → paid → fulfilled → delivered, with partial fulfilment
- Refund and return processing with RMA workflow
- Customer profiles with lifetime value and order history
- Discount builder (percentage, fixed, BOGO, free shipping; usage limits, date windows, eligibility rules)
- Analytics: revenue, AOV, conversion funnel, top products, cohort retention
- Role-based access control (owner / admin / staff / fulfilment) with an immutable audit log

### Platform

- Versioned REST API with auto-generated OpenAPI 3.1 and a typed TypeScript client
- Background workers for email, webhooks, search indexing, report generation
- Structured JSON logging with request correlation IDs
- OpenTelemetry tracing, Prometheus metrics, Sentry error tracking
- Rate limiting per IP and per account
- Docker Compose for local development; containerised deploys
- CI pipeline: lint, type-check, unit, integration, E2E, security scan, Lighthouse budget

---

## Architecture at a glance

```
                          ┌──────────────────────────┐
                          │        Customers         │
                          └────────────┬─────────────┘
                                       │ HTTPS
                          ┌────────────▼─────────────┐
                          │   CDN / Edge (Vercel)    │
                          └────────────┬─────────────┘
                                       │
          ┌────────────────────────────┼────────────────────────────┐
          │                            │                            │
┌─────────▼──────────┐     ┌───────────▼──────────┐     ┌───────────▼─────────┐
│  Storefront        │     │  Admin Dashboard     │     │  Future clients     │
│  Next.js 15 / RSC  │     │  Next.js 15 / SPA    │     │  mobile, POS, ...   │
└─────────┬──────────┘     └───────────┬──────────┘     └───────────┬─────────┘
          └────────────────────────────┼────────────────────────────┘
                                       │  REST + OpenAPI, typed client
                          ┌────────────▼─────────────┐
                          │       FastAPI API        │
                          │  routers → services →    │
                          │  repositories            │
                          └──┬────────┬────────┬─────┘
                             │        │        │
         ┌───────────────────┘        │        └──────────────────┐
         │                            │                           │
┌────────▼─────────┐  ┌───────────────▼──────┐  ┌─────────────────▼────────┐
│  PostgreSQL 16   │  │  Redis 7             │  │  Meilisearch             │
│  system of record│  │  cache, sessions,    │  │  product search index    │
│  + read replica  │  │  locks, rate limits, │  │                          │
│                  │  │  job queue           │  │                          │
└──────────────────┘  └───────────┬──────────┘  └──────────────────────────┘
                                  │
                      ┌───────────▼──────────┐   ┌──────────────────────────┐
                      │  ARQ workers         │──▶│  Stripe / Paystack       │
                      │  email, webhooks,    │   │  Resend (email)          │
                      │  indexing, reports   │   │  S3 / Cloudflare R2      │
                      └──────────────────────┘   └──────────────────────────┘
```

**Layering inside the API** — strictly one-directional, so business rules stay testable without HTTP or a database:

```
HTTP router  →  service (business logic)  →  repository (data access)  →  SQLAlchemy  →  Postgres
     ↑                                            ↑
  Pydantic schemas at the boundary          domain objects only, no ORM leakage upward
```

Full detail in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Technology choices and why

| Layer                     | Choice                                             | Why this and not the alternative                                                                                                                                                                                                                                                                          |
| ------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **API framework**         | FastAPI (Python 3.12)                              | Async-native, so I/O-bound payment and webhook calls do not block. Pydantic v2 validation at the boundary is compiled in Rust and genuinely fast. OpenAPI generation is free, which is what makes the typed frontend client possible.                                                                     |
| **ORM**                   | SQLAlchemy 2.0 (async) + Alembic                   | The only Python ORM mature enough for real commerce queries. 2.0's typed `select()` API catches errors at type-check time. Alembic gives reviewable, reversible migrations — non-negotiable for a schema holding financial records.                                                                       |
| **Database**              | PostgreSQL 16                                      | See [below](#why-postgresql--and-how-it-stays-fast-at-scale).                                                                                                                                                                                                                                             |
| **Cache / queue / locks** | Redis 7                                            | One dependency covering cache, session store, rate-limit counters, distributed locks, and the job queue. Fewer moving parts than Redis + RabbitMQ at this scale.                                                                                                                                          |
| **Job runner**            | ARQ                                                | Async-native, so it shares the exact same `async def` service code as the API. Celery is battle-tested but its async story is awkward and would force sync duplicates of every service call.                                                                                                              |
| **Search**                | Meilisearch                                        | Sub-50ms typo-tolerant faceted search in a one-container footprint. Elasticsearch is more powerful and far heavier than a product catalog needs; Postgres full-text is free but weak on typo tolerance and facet ergonomics.                                                                              |
| **Frontend**              | Next.js 15 (App Router) + React 19                 | Server Components render product pages on the server for SEO and first paint, while cart and checkout stay fully interactive on the client. Streaming SSR and per-route caching are what make a large catalog feel instant.                                                                               |
| **Styling**               | Tailwind CSS 4 + shadcn/ui (Radix)                 | Tailwind keeps styling colocated and purges to a tiny bundle. Radix primitives are accessible by construction — correct focus management, keyboard behaviour, ARIA — which is most of the WCAG work done for free. shadcn/ui vendors components into the repo, so there is no opaque dependency to fight. |
| **Client state**          | TanStack Query + Zustand                           | TanStack Query owns server state (caching, revalidation, optimistic cart updates). Zustand owns the small amount of genuinely client state (drawers, filter panels). Redux is unnecessary ceremony once server state is handled properly.                                                                 |
| **Forms**                 | React Hook Form + Zod                              | Uncontrolled inputs mean checkout does not re-render on every keystroke. Zod schemas are generated from the backend's OpenAPI spec, so validation rules cannot drift between client and server.                                                                                                           |
| **Payments**              | Stripe (primary), Paystack/Flutterwave (secondary) | Stripe Payment Elements keeps us in PCI-DSS SAQ-A — card data never reaches our infrastructure. A provider-agnostic `PaymentProvider` interface makes adding a regional processor one adapter, not a refactor.                                                                                            |
| **Email**                 | Resend + React Email                               | Transactional templates written as React components, so they are reviewed and versioned like the rest of the UI.                                                                                                                                                                                          |
| **Media**                 | Cloudflare R2 (S3-compatible)                      | Zero egress fees, which matters a great deal for product imagery. S3-compatible, so switching is a config change.                                                                                                                                                                                         |
| **Auth**                  | Custom JWT, httpOnly cookies, Argon2id             | Access token (15 min) plus rotating refresh token (30 days) with reuse detection. Argon2id is the current OWASP password-hashing recommendation. Self-hosted keeps user data out of a third party.                                                                                                        |
| **Testing**               | pytest + testcontainers, Vitest, Playwright        | Integration tests run against a real Postgres in a container, not SQLite — because the behaviour that matters (row locks, constraints, transaction isolation) does not exist in SQLite.                                                                                                                   |

---

## Why PostgreSQL — and how it stays fast at scale

The brief asked for a database that is **scalable and fast**. For e-commerce, that phrase has a specific meaning, and it points firmly at Postgres.

### The requirement is correctness first, speed second

A store is a financial system. Its workload is dominated by operations that must be atomic across multiple tables: _reserve inventory, apply discount, create order, record payment, decrement stock_ either all happen or none do. A document store or a key-value store makes you implement that guarantee yourself, in application code, correctly, forever. Postgres gives it to you as `BEGIN ... COMMIT`.

Concretely, Velo relies on Postgres features that are genuinely hard to replicate:

- **Serialisable and row-level locking** — `SELECT ... FOR UPDATE` on the inventory row is what makes overselling structurally impossible under concurrency.
- **Real constraints** — `CHECK (quantity >= 0)` means the database itself refuses to hold negative stock, even if a future bug tries. Foreign keys mean an order line cannot reference a deleted variant.
- **Exact money arithmetic** — `BIGINT` minor units and `NUMERIC` where fractional rates are needed. No floating-point drift, ever.
- **`JSONB`** — schemaless product attributes and provider webhook payloads live in indexed JSONB columns, giving document-store flexibility _inside_ a relational database, with GIN indexes to query it.
- **Partial and expression indexes** — `CREATE INDEX ... WHERE status = 'pending'` keeps hot-path queries fast without indexing cold rows.
- **Native full-text search** — a capable fallback if you would rather not run Meilisearch.
- **Logical replication** — read replicas for analytics and catalog reads, with no application changes.

### How it scales, in the order you should actually do it

Scaling is a sequence, not a decision made on day one. Each step below is taken only when measurement says the previous one has run out:

1. **Index correctly.** Most "Postgres is slow" reports are a missing index. Every hot query in this project has a defined index in [docs/DATA-MODEL.md](docs/DATA-MODEL.md), and `EXPLAIN ANALYZE` output is reviewed in PRs that touch queries.
2. **Pool connections.** PgBouncer in transaction mode. Postgres backends are expensive; 10,000 client connections must become ~50 server connections.
3. **Cache aggressively.** Product and collection reads are 95%+ of traffic and change rarely. Redis-cached, invalidated by event on write. This alone takes an order of magnitude off database load.
4. **Read replicas.** Route catalog browsing and analytics to replicas; keep cart, checkout, and all writes on the primary. Session-consistent routing so a user never reads their own write as stale.
5. **Partition the large tables.** `orders` and `order_events` partition cleanly by month once past roughly 50M rows. Old partitions detach to cold storage.
6. **Offload search.** Faceted search is a search-engine workload, not a database one. Meilisearch owns it from day one.
7. **Only then consider sharding** — by tenant, if this ever becomes multi-store SaaS. Managed options (Neon, Citus, AlloyDB) handle this without an application rewrite.

### Deployment recommendation

| Stage                      | Setup                                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Local                      | Postgres 16 in Docker Compose                                                                               |
| Staging / early production | **Neon** — serverless Postgres, scales to zero, database branching per pull request, point-in-time recovery |
| Scale                      | **AWS RDS / Aurora Postgres** or **Google Cloud SQL** — multi-AZ, automated failover, managed read replicas |

Neon's per-PR database branching is the standout feature for a project like this: every pull request gets an isolated copy of production-shaped data to run migrations and integration tests against.

Full schema, indexes, and partitioning strategy: [docs/DATA-MODEL.md](docs/DATA-MODEL.md).

---

## Repository layout

Entries marked **✓** exist today (Phase 3); the rest arrive in the phase that owns them.

```
velo-commerce/
├── apps/
│   ├── api/                      # FastAPI backend                        ✓
│   │   ├── velo/
│   │   │   ├── main.py           # app factory, middleware, lifespan      ✓
│   │   │   ├── core/             # config, logging, errors, middleware    ✓
│   │   │   ├── db/               # engine, session, redis; migrations/ in Phase 4
│   │   │   ├── api/              # health, v1 routers                     ✓
│   │   │   ├── domains/          # one package per bounded context
│   │   │   │   ├── system/       # walking skeleton — the layering template ✓
│   │   │   │   ├── catalog/      # router · schemas · service · repository · models
│   │   │   │   ├── identity/
│   │   │   │   ├── cart/
│   │   │   │   ├── checkout/
│   │   │   │   ├── payments/
│   │   │   │   ├── orders/
│   │   │   │   ├── inventory/
│   │   │   │   ├── discounts/
│   │   │   │   ├── shipping/
│   │   │   │   └── admin/
│   │   │   ├── integrations/     # stripe · paystack · resend · s3 · meilisearch
│   │   │   └── workers/          # ARQ task definitions
│   │   └── tests/                # unit ✓ · integration ✓ · concurrency (Phase 7)
│   ├── storefront/               # Next.js customer-facing app             ✓
│   │   └── src/
│   │       ├── app/              # App Router routes                      ✓
│   │       ├── components/       # ui · product · cart · checkout · layout
│   │       └── lib/              # api-client · hooks · stores · utils
│   └── admin/                    # Next.js admin dashboard                ✓
├── packages/
│   ├── api-client/               # TS client generated from OpenAPI       ✓
│   ├── ui/                       # shared design-system components (Phase 10)
│   └── config/                   # shared eslint, tsconfig, design tokens ✓
├── docker/                       # Dockerfiles and compose files          ✓
├── scripts/                      # seed, backup, codegen, release
├── docs/                         # discovery, architecture, ADRs, data model, API, payments, design ✓
├── legacy/                       # the archived Loyverse↔Cloudbeds bridge ✓
├── .github/workflows/            # CI                                     ✓
├── CONTRIBUTING.md               # conventions and the review checklist   ✓
├── PLANNING.md                   # ← the build plan and task board        ✓
└── README.md
```

---

## Getting started

### Prerequisites

| Tool                        | Version | Check              |
| --------------------------- | ------- | ------------------ |
| Python                      | 3.12+   | `python --version` |
| Node.js                     | 20+     | `node --version`   |
| pnpm                        | 9+      | `pnpm --version`   |
| Docker Desktop              | latest  | `docker --version` |
| uv (Python package manager) | latest  | `uv --version`     |

You will also need free accounts at [Stripe](https://stripe.com) (test mode), [Resend](https://resend.com), and [Cloudflare R2](https://developers.cloudflare.com/r2/) or any S3-compatible store.

### Setup — what runs today

The walking skeleton (Phase 3). Steps 1–5 are the whole of it; everything after is added by the phase that owns it.

```bash
# 1. Clone and enter
git clone <your-repo-url> velo-commerce
cd velo-commerce

# 2. Environment
cp .env.example .env
#    The defaults match the dev containers below. VELO_SECRET_KEY is the only
#    one you must set, and any 32+ character string will do locally.

# 3. Start infrastructure (Postgres 16, Redis 7, Meilisearch, MailHog)
pnpm infra:up                             # docker compose, under the hood
#    Port 5432 already taken by a Postgres installed on the host (common on
#    Windows)? Symptom: "password authentication failed for user velo".
#    Move the container:  VELO_POSTGRES_PORT=5433 pnpm infra:up
#    and use port 5433 in VELO_DATABASE_URL.

# 4. API
cd apps/api
uv sync --all-groups                      # install, including dev tooling
uv run alembic upgrade head               # create the schema
uv run python -m velo.scripts.seed        # demo catalog, admin, and customer
#    From the repo root instead: pnpm db:migrate, pnpm db:seed,
#    or pnpm db:reset (drop everything, migrate, seed).
uv run uvicorn velo.main:app --reload --port 8000
#    → http://localhost:8000/docs
#    → http://localhost:8000/api/v1/system/info   (reads Postgres)

# 5. Frontends (new terminal, from the repo root)
pnpm install
pnpm dev                                  # both apps
#    or: pnpm dev:storefront / pnpm dev:admin
#    → http://localhost:3000 renders the value the API read from Postgres
```

Checks, from the repo root and from `apps/api`:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build   # TypeScript
cd apps/api && uv run ruff check . && uv run mypy . && uv run pytest

# API integration tests — need the containers from step 3
VELO_RUN_INTEGRATION=1 uv run pytest
#    Postgres on another port? Point the tests at it (they use the velo_test database):
#    VELO_TEST_DATABASE_URL=postgresql+asyncpg://velo:velo@localhost:5433/velo_test
```

### Setup — added by later phases

```bash
# Phase 8 — payments
stripe listen --forward-to localhost:8000/api/v1/webhooks/stripe
#    Copy the printed whsec_... into VELO_STRIPE_WEBHOOK_SECRET, restart the API.
```

### Where things are

| Service               | URL                                     | Notes                                      |
| --------------------- | --------------------------------------- | ------------------------------------------ |
| Storefront            | http://localhost:3000                   |                                            |
| Admin                 | http://localhost:3001                   | `admin@velo.dev` / `ChangeMe123!` (seeded) |
| API                   | http://localhost:8000                   |                                            |
| API docs (Swagger)    | http://localhost:8000/docs              | Disabled in production                     |
| OpenAPI document      | http://localhost:8000/openapi.json      | Source of the generated TS client          |
| Liveness / readiness  | http://localhost:8000/health · `/ready` | `/ready` checks Postgres and Redis         |
| Meilisearch           | http://localhost:7700                   |                                            |
| MailHog (email inbox) | http://localhost:8025                   | catches all outbound dev mail              |

### Test cards (Stripe test mode)

| Card                  | Behaviour                              |
| --------------------- | -------------------------------------- |
| `4242 4242 4242 4242` | Succeeds                               |
| `4000 0025 0000 3155` | Requires 3-D Secure authentication     |
| `4000 0000 0000 9995` | Declined — insufficient funds          |
| `4000 0000 0000 0341` | Attaches successfully, fails on charge |

Any future expiry, any CVC, any postcode.

---

## Environment variables

| Variable                                                  | Example                                              | Purpose                                    |
| --------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------ |
| `ENVIRONMENT`                                             | `development`                                        | `development` \| `staging` \| `production` |
| `DATABASE_URL`                                            | `postgresql+asyncpg://velo:velo@localhost:5432/velo` | Primary Postgres connection                |
| `DATABASE_REPLICA_URL`                                    | _(optional)_                                         | Read-replica connection                    |
| `REDIS_URL`                                               | `redis://localhost:6379/0`                           | Cache, queue, locks, rate limits           |
| `MEILISEARCH_URL`                                         | `http://localhost:7700`                              | Search host                                |
| `MEILISEARCH_MASTER_KEY`                                  | `...`                                                | Search admin key                           |
| `JWT_SECRET_KEY`                                          | `openssl rand -hex 32`                               | Token signing — **rotate per environment** |
| `JWT_ACCESS_TTL_MINUTES`                                  | `15`                                                 | Access token lifetime                      |
| `JWT_REFRESH_TTL_DAYS`                                    | `30`                                                 | Refresh token lifetime                     |
| `STRIPE_SECRET_KEY`                                       | `sk_test_...`                                        | Server-side Stripe calls                   |
| `STRIPE_PUBLISHABLE_KEY`                                  | `pk_test_...`                                        | Exposed to the browser                     |
| `STRIPE_WEBHOOK_SECRET`                                   | `whsec_...`                                          | Webhook signature verification             |
| `PAYSTACK_SECRET_KEY`                                     | _(optional)_                                         | Secondary provider                         |
| `RESEND_API_KEY`                                          | `re_...`                                             | Transactional email                        |
| `EMAIL_FROM`                                              | `orders@yourstore.com`                               | Sender identity                            |
| `S3_ENDPOINT_URL`                                         | `https://<acct>.r2.cloudflarestorage.com`            | Media storage                              |
| `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` |                                                      | Media credentials                          |
| `CORS_ORIGINS`                                            | `http://localhost:3000,http://localhost:3001`        | Allowed frontend origins                   |
| `SENTRY_DSN`                                              | _(optional)_                                         | Error tracking                             |
| `NEXT_PUBLIC_API_URL`                                     | `http://localhost:8000`                              | Frontend → API base URL                    |

> **Never commit `.env`.** It is gitignored. Production secrets belong in your platform's secret manager (Vercel / Fly / AWS Secrets Manager), not in the repository.

---

## Common commands

```bash
# ── Backend ────────────────────────────────────────────────
uv run uvicorn velo.main:app --reload       # dev server
uv run alembic revision --autogenerate -m "add wishlists"
uv run alembic upgrade head                 # apply migrations
uv run alembic downgrade -1                 # roll back one
uv run arq velo.workers.WorkerSettings      # background worker
uv run pytest                               # tests
uv run pytest --cov=velo --cov-report=html  # tests + coverage
uv run ruff check --fix . && uv run ruff format .
uv run mypy src/

# ── Frontend ───────────────────────────────────────────────
pnpm dev                                    # all apps
pnpm --filter storefront build
pnpm lint && pnpm typecheck
pnpm test                                   # Vitest unit tests
pnpm test:e2e                               # Playwright
pnpm generate:api                           # regenerate TS client from OpenAPI (no running API needed)

# ── Operations ─────────────────────────────────────────────
pnpm db:seed                                # reseed demo data
pnpm db:reset                               # drop, migrate, seed
pnpm search:reindex                         # rebuild Meilisearch index
```

---

## Testing

| Layer                 | Tool                                     | What it covers                                                            | Target              |
| --------------------- | ---------------------------------------- | ------------------------------------------------------------------------- | ------------------- |
| Unit (backend)        | pytest                                   | Pricing engine, discount rules, tax, shipping calculators, state machines | 90%+ on `services/` |
| Integration (backend) | pytest + testcontainers                  | Real Postgres: transactions, row locks, constraints, full API routes      | All endpoints       |
| Contract              | schemathesis                             | Every response conforms to the OpenAPI schema                             | Auto-generated      |
| Unit (frontend)       | Vitest + Testing Library                 | Components, hooks, form validation                                        | 80%+                |
| E2E                   | Playwright                               | Browse → cart → checkout → payment → order, on Chromium/Firefox/WebKit    | All critical paths  |
| Load                  | k6                                       | 500 concurrent checkouts; p95 latency and oversell assertions             | Pre-launch gate     |
| Accessibility         | axe-core in Playwright                   | WCAG 2.1 AA on every page                                                 | Zero violations     |
| Security              | Bandit, `pip-audit`, `pnpm audit`, Trivy | Dependency CVEs, container CVEs, common Python flaws                      | Zero high/critical  |

**The concurrency tests are the ones that matter most.** There is a dedicated suite that spawns N simultaneous checkouts against a single unit of stock and asserts that exactly one order exists afterwards. If that test ever goes red, the build does not ship.

---

## Deployment

| Component          | Platform                                       | Notes                                                   |
| ------------------ | ---------------------------------------------- | ------------------------------------------------------- |
| Storefront + Admin | **Vercel**                                     | Native Next.js support, edge CDN, preview deploy per PR |
| API                | **Fly.io** or **Railway**                      | Multi-region containers, close to the database          |
| Workers            | Same platform, separate process group          | Scales independently of the API                         |
| Database           | **Neon** → **RDS/Aurora** at scale             | PITR, per-PR branching                                  |
| Redis              | **Upstash** or managed Redis                   |                                                         |
| Search             | **Meilisearch Cloud** or self-hosted container |                                                         |
| Media              | **Cloudflare R2**                              | Zero egress                                             |

**Pipeline:** push → lint + type-check → unit tests → integration tests (containerised Postgres) → build → E2E against preview → manual approval → migrate → deploy API → deploy frontends → smoke test → auto-rollback on failed health check.

Migrations are **expand/contract**: add the new column, backfill, deploy code that writes both, deploy code that reads new, drop the old column in a later release. No deploy ever requires downtime, and every deploy can roll back to the previous image without a schema conflict.

---

## Documentation map

| Document                                                                             | Contents                                                                                                              |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| [PLANNING.md](PLANNING.md)                                                           | **The build plan.** Every phase, every task, with checkboxes. Start here.                                             |
| [docs/DISCOVERY.md](docs/DISCOVERY.md)                                               | Personas, user journeys, catalog shape, business metrics, SLOs, load projections, retention, PCI scope, risk register |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                                         | System design, layering rules, ADRs, failure modes, scaling path                                                      |
| [docs/adr/](docs/adr/)                                                               | The ten architecture decision records in full — context, rejected options, consequences, revisit triggers             |
| [docs/DATA-MODEL.md](docs/DATA-MODEL.md)                                             | Full schema, ERD, indexes, constraints, money handling, concurrency strategy                                          |
| [docs/API-SPEC.md](docs/API-SPEC.md)                                                 | Endpoint reference, auth flow, errors, pagination, idempotency, rate limits                                           |
| [docs/PAYMENTS-AND-CHECKOUT.md](docs/PAYMENTS-AND-CHECKOUT.md)                       | Checkout state machine, payment sequence diagrams, webhooks, refunds, PCI scope                                       |
| [docs/DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM.md)                                       | Tokens, type scale, components with a state matrix, motion, accessibility, performance budgets                        |
| [docs/PAGE-SPECS.md](docs/PAGE-SPECS.md)                                             | Every screen — storefront, account, admin — with layout, mobile behaviour, states, and accessibility notes            |
| [docs/legacy-loyverse-cloudbeds-bridge.md](docs/legacy-loyverse-cloudbeds-bridge.md) | Archived docs for the previous occupant of this repo                                                                  |

---

## Project status

**Planning complete; Phase 3 — Foundation & Dev Environment — in progress.** Discovery is closed, all ten ADRs are written, and the architecture, data model, API surface, payment flow, design system, and every page spec are done. The one outstanding design task is a clickable checkout prototype.

**41 of 326 tasks complete (13%).**

Live task board with completion status: [PLANNING.md](PLANNING.md).

---

## License

MIT.
