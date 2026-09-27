# Velo Commerce — Build Plan & Task Board

> **This is the working document.** Every task below has a checkbox. Tick it when the task meets its Definition of Done. Update the progress table at the top as phases complete.
>
> **Last updated:** 2026-09-27
> **Current phase:** Phase 3 — Foundation & Dev Environment. 23/24: everything verified on the development machine, including all three Docker images; the clean-clone run on a second machine and a first green CI run on GitHub remain — see the note at the head of Phase 3. Phases 0 and 1 are complete; Phase 2 is 16/17.

---

## How to use this document

| Marker  | Meaning                                               |
| ------- | ----------------------------------------------------- |
| `- [ ]` | Not started                                           |
| `- [~]` | In progress                                           |
| `- [x]` | **Done** — meets the Definition of Done for its phase |
| `- [!]` | Blocked — reason noted inline                         |
| `- [-]` | Descoped — moved to the backlog, reason noted inline  |

**Rules of engagement**

1. Do not tick a box until the phase's **Definition of Done** is satisfied. "It runs on my machine" is not done.
2. Every task that changes behaviour ships with a test. No test, no tick.
3. If a task is blocked, mark it `- [!]` and write the blocker inline — do not silently skip it.
4. Phases are ordered by dependency, not by preference. Phases 3–5 gate everything after them.
5. Re-estimate at the end of every phase. Estimates below are for one full-time developer.

---

## Progress

| #   | Phase                           |   Tasks |   Done | Status                                       | Est.          |
| --- | ------------------------------- | ------: | -----: | -------------------------------------------- | ------------- |
| 0   | Discovery & Definition          |      14 |     13 | ✅ Done — 1 standing                         | 3 d           |
| 1   | Architecture & Decisions        |      12 |     12 | ✅ Done                                      | 3 d           |
| 2   | UX & Visual Design              |      17 |     16 | 🚧 1 left — prototype                        | 5 d           |
| 3   | Foundation & Dev Environment    |      24 |     23 | 🚧 1 left — clean-clone run on a 2nd machine | 4 d           |
| 4   | Database & Migrations           |      15 |      0 | 🔜 Not started                               | 4 d           |
| 5   | Identity & Access               |      16 |      0 | 🔜 Not started                               | 5 d           |
| 6   | Catalog & Search                |      19 |      0 | 🔜 Not started                               | 7 d           |
| 7   | Cart & Pricing Engine           |      12 |      0 | 🔜 Not started                               | 5 d           |
| 8   | Checkout & Payments             |      34 |      0 | 🔜 Not started                               | 10 d          |
| 9   | Orders, Fulfilment & Returns    |      13 |      0 | 🔜 Not started                               | 6 d           |
| 10  | Storefront UI                   |      35 |      0 | 🔜 Not started                               | 12 d          |
| 11  | Admin Dashboard                 |      18 |      0 | 🔜 Not started                               | 10 d          |
| 12  | Notifications & Background Jobs |      12 |      0 | 🔜 Not started                               | 4 d           |
| 13  | Testing & QA                    |      15 |      0 | 🔜 Not started                               | 6 d           |
| 14  | Performance & SEO               |      13 |      0 | 🔜 Not started                               | 4 d           |
| 15  | Security Hardening              |      16 |      0 | 🔜 Not started                               | 5 d           |
| 16  | Observability                   |      10 |      0 | 🔜 Not started                               | 3 d           |
| 17  | Deployment & Launch             |      21 |      0 | 🔜 Not started                               | 5 d           |
| 18  | Post-Launch                     |      10 |      0 | 🔜 Not started                               | ongoing       |
|     | **Total**                       | **326** | **53** | **16%**                                      | **~19 weeks** |

_Task counts are the real checkbox count per phase, verified against the document. The original table under-counted by 25; the estimates are unchanged, since they were made against the work rather than against the count._

**Milestones**

| Milestone                 | Gate                                                                           | Phases |
| ------------------------- | ------------------------------------------------------------------------------ | ------ |
| **M1 — Walking skeleton** | A request reaches the API, hits Postgres, and renders in Next.js. CI is green. | 0–3    |
| **M2 — Catalog live**     | Products browsable and searchable end to end.                                  | 4–6    |
| **M3 — First payment**    | A real test card completes a real order. **The critical milestone.**           | 7–8    |
| **M4 — Operable**         | An operator can run the store without touching the database.                   | 9–11   |
| **M5 — Production ready** | All gates green: tests, performance, security, accessibility.                  | 12–16  |
| **M6 — Launched**         | Live, monitored, with a rollback tested.                                       | 17     |

---

# Phase 0 — Discovery & Definition

_Before a line of code. The point of this phase is to make the expensive decisions cheap by making them early._

> **Deliverable: [`docs/DISCOVERY.md`](docs/DISCOVERY.md)** — personas, journeys, catalog shape, business metrics, SLOs, load projections, retention schedule, PCI scope, risk register, and the open questions with the phase each must be answered by.

### 0.1 Define the product

- [x] Write the one-sentence product statement and validate it against the README
- [x] Define the **three primary personas** — Shopper, Store Operator, Developer/Integrator — with goals and frustrations for each
- [x] Map the **critical user journeys** end to end: discover → evaluate → purchase → receive → return
- [x] Define what is explicitly **out of scope for v1** (multi-vendor marketplace, subscriptions, B2B quotes, multi-currency pricing, multi-warehouse, POS integration) and record why
- [x] Agree the **launch catalog shape**: expected SKU count, variant depth, image count per product. Sizing decisions depend on this.

### 0.2 Define success

- [x] Set **business metrics**: target conversion rate, average order value, cart-abandonment rate
- [x] Set **technical SLOs**: 99.9% API availability, p95 API latency < 200 ms, p95 page LCP < 2.0 s, zero oversells
- [x] Set **Core Web Vitals budgets**: LCP < 2.0 s, INP < 200 ms, CLS < 0.1 — to be enforced in CI

### 0.3 Non-functional requirements

- [x] Document expected load: peak concurrent users, orders/hour at launch and at 12 months
- [x] Document data-retention and privacy requirements (GDPR/NDPR: right to erasure, data export, consent, cookie policy)
- [x] Document compliance scope: **PCI-DSS SAQ-A** (no card data on our servers) — confirm the integration approach guarantees this
- [x] Define the accessibility standard: **WCAG 2.1 Level AA**, non-negotiable, gated in CI

### 0.4 Risk register

- [x] Build the risk register with likelihood × impact and a mitigation for each

**The register lives in [`docs/DISCOVERY.md`](docs/DISCOVERY.md) §9** — 15 risks with likelihood, impact, exposure, mitigation, and the phase that owns each. The seven items that were listed here are the first seven of those. The highest-exposure ones, repeated because they shape the phase ordering:

| Risk                                           | Exposure | Owner phase |
| ---------------------------------------------- | -------- | ----------- |
| R1 — Overselling under concurrency             | High     | 7           |
| R2 — Duplicate charges                         | High     | 8           |
| R3 — Lost webhooks → paid orders never created | High     | 8           |
| R5 — Slow catalog as SKUs grow                 | High     | 6           |
| R6 — Scope creep past launch date              | High     | standing    |
| R9 — Tax calculated wrongly                    | High     | 8 / 17      |

- [~] Review the register at the end of every phase and update likelihoods — _standing task; next review due at the end of Phase 3. Register lives in `docs/DISCOVERY.md` §9._

**Definition of Done — Phase 0:** All decisions above are written down in `docs/` and would survive a stakeholder asking "why?". Nothing in this phase is code.

---

# Phase 1 — Architecture & Decisions

_Record decisions as ADRs so that in six months the reasoning survives, not just the outcome._

> **Deliverables: [`docs/adr/`](docs/adr/) (index, template, ADR-001 … ADR-010) and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).** Every ADR records its rejected options and a "Revisit when" trigger.

- [x] Create `docs/adr/` with a numbered ADR template (Context / Options / Decision / Consequences)
- [x] **ADR-001** — Monorepo (pnpm workspaces + uv) vs polyrepo
- [x] **ADR-002** — PostgreSQL as system of record (see README rationale)
- [x] **ADR-003** — FastAPI over Express/Django; how this reconciles with the "PERN" brief
- [x] **ADR-004** — Layered modular monolith over microservices for v1, with the extraction seams named
- [x] **ADR-005** — Money represented as `BIGINT` minor units + ISO-4217 currency code
- [x] **ADR-006** — Stripe as primary PSP behind a `PaymentProvider` interface; Paystack/Flutterwave as second adapter
- [x] **ADR-007** — Meilisearch over Elasticsearch or Postgres FTS
- [x] **ADR-008** — JWT in httpOnly cookies over localStorage tokens or server sessions
- [x] **ADR-009** — ARQ over Celery for background jobs
- [x] **ADR-010** — Order finalisation driven by webhooks, never by client redirect
- [x] Write `docs/ARCHITECTURE.md`: component diagram, layering rules, request lifecycle, failure modes, scaling path

**Definition of Done — Phase 1:** Every significant technology choice has an ADR with its rejected alternatives recorded. A new engineer can read `docs/ARCHITECTURE.md` and correctly place a new feature in the codebase.

---

# Phase 2 — UX & Visual Design

_Design before build. Rework in Figma costs minutes; rework in React costs days._

### 2.1 Foundations

- [x] Define the design token set: colour (light + dark), type scale, spacing scale, radii, shadows, motion durations and easings
- [x] Verify **every** foreground/background pair against WCAG AA (4.5:1 body, 3:1 large text and UI boundaries) in both themes
- [x] Choose and license typefaces; define the fluid type scale with `clamp()`
- [x] Define the responsive breakpoints and the grid at each
- [x] Define the motion language: what animates, how long, and what `prefers-reduced-motion` disables

### 2.2 Component library

- [x] Design the primitive set: Button (all variants and states), Input, Select, Checkbox, Radio, Badge, Card, Dialog, Sheet, Toast, Tooltip, Skeleton
- [x] Design commerce components: ProductCard, PriceDisplay (with compare-at), VariantSelector, QuantityStepper, StockIndicator, RatingStars, CartLineItem, OrderSummary, AddressForm, StepIndicator
- [x] Specify every interactive state: default, hover, focus-visible, active, disabled, loading, error — _state matrix in `docs/DESIGN-SYSTEM.md` §4_
- [x] Design empty states, loading skeletons, and error states for every data-bearing component — **these are not optional**

### 2.3 Page design

- [x] Home, category/collection listing, product detail, cart, the four checkout steps, order confirmation — _`docs/PAGE-SPECS.md` Part 1; product detail and checkout in `docs/DESIGN-SYSTEM.md` §5_
- [x] Account area: login, register, order history, order detail, addresses, returns — _`docs/PAGE-SPECS.md` Part 2_
- [x] Admin: dashboard, product list, product editor, order list, order detail, discount builder — _`docs/PAGE-SPECS.md` Part 3_
- [x] Mobile designs for every page above — **design mobile first**, the majority of traffic is mobile — _per-page, plus the coverage checklist in `docs/PAGE-SPECS.md`_
- [x] Design the checkout flow specifically for minimum friction: measure the field count, kill every field that is not legally or operationally required
- [x] Accessibility annotation pass: tab order, focus traps in dialogs, ARIA labels, live-region announcements, skip links

### 2.4 Sign-off

- [x] Write `docs/DESIGN-SYSTEM.md` — tokens, component specs, page specs, accessibility rules
- [ ] Prototype and click through the full checkout flow before any of it is coded

**Definition of Done — Phase 2:** Every screen exists at mobile and desktop, in light and dark, with all states specified. Contrast is verified, not assumed. A developer can build any screen without asking a design question.

---

# Phase 3 — Foundation & Dev Environment

_Milestone M1 — the walking skeleton. Small in features, large in leverage: everything after this is faster because of it._

> **Status (2026-09-27).** **The M1 walking skeleton runs end to end on the development machine, from source and from the production images:** Postgres → API → storefront renders the database version through the generated, typed client. API: ruff and mypy strict clean, 25 tests including integration against real Postgres and Redis. Web: `tsc`, ESLint, Prettier, 22 vitest tests, and `next build` for both apps. Images: API, storefront, and admin all build, start as non-root, and serve. Pre-commit: all 15 hooks pass. **Not yet run:** CI on GitHub (the repository has no commits and no remote yet) and a fresh-clone run on a second machine. Disk remains tight — 7.6 GB free on C: after the image builds.
>
> Tasks are marked `[~]` where an artefact exists but has never been executed, and `[x]` only where it has been run and checked.

### 3.1 Repository

- [x] `git init`; set up the monorepo (`apps/`, `packages/`, `docs/`, `docker/`, `scripts/`) — _`legacy/`, `apps/`, `packages/`, `docker/`, `scripts/` created; repository initialised_
- [x] **Move the legacy Loyverse↔Cloudbeds files** (`main.py`, `models.py`, `cloudbeds.py`, `loyverse.py`, `tasks.py`, root `Dockerfile`) out of the root — to their own repository, or delete them once archived. They are unrelated to this project and will cause import confusion. — _moved to `legacy/` with a README; **not deleted** — retiring the bridge is the owner's call_
- [x] Configure pnpm workspaces and the shared `packages/config` (eslint, tsconfig, tailwind preset) — _`pnpm-workspace.yaml`, root `package.json`, `packages/config` (eslint, tsconfig, design tokens)_
- [x] Write `.gitignore`, `.editorconfig`, `.nvmrc`, `.python-version`
- [x] Write `CONTRIBUTING.md`: branch naming, commit convention (Conventional Commits), PR template, review checklist
- [x] Add `LICENSE` — _MIT_

### 3.2 Backend skeleton

- [x] Scaffold `apps/api` with `pyproject.toml` managed by uv; pin Python 3.12 — _`apps/api/pyproject.toml`, Python pinned to 3.12_
- [x] Implement the app factory in `velo/main.py`: lifespan, CORS, middleware stack, router registration — _verified 2026-09-25: ruff, mypy strict, and 22 unit tests pass; uvicorn boots and serves it_
- [x] Implement `core/config.py` — Pydantic `BaseSettings`, fully typed, fails fast on a missing required variable — _verified 2026-09-25 — first run found a real bug: `VELO_CORS_ORIGINS=http://…` crashed startup because pydantic-settings JSON-decodes list fields from env vars. Fixed with `NoDecode`; regression test added_
- [x] Implement structured JSON logging with a per-request correlation ID — _verified 2026-09-25: ruff, mypy strict, and 22 unit tests pass; uvicorn boots and serves it_
- [x] Implement the global exception handler and the RFC-9457 `application/problem+json` error envelope — _verified 2026-09-25: ruff, mypy strict, and 22 unit tests pass; uvicorn boots and serves it_
- [x] Add `/health` (liveness) and `/ready` (checks Postgres and Redis) endpoints — _verified 2026-09-26 against the dev containers: `/ready` returns 200 `ready` with both up, 503 `degraded` with both down; covered by an integration test_
- [x] Configure Ruff (lint + format) and mypy in strict mode — _both clean as of 2026-09-25 (ruff found 6 issues, mypy 8 stale `type: ignore`s; all fixed)_

### 3.3 Frontend skeleton

- [x] Scaffold `apps/storefront` — Next.js 15, App Router, TypeScript strict — _verified 2026-09-25: `tsc`, ESLint, and `next build` pass. First run fixed missing `eslint`/`@types/node` devDependencies, type-aware lint on `.mjs` files, a directive for a rule that was never loaded, and made `output: "standalone"` opt-in (`NEXT_OUTPUT_STANDALONE=1`, set in `docker/web.Dockerfile`) because its symlinks fail on Windows without Developer Mode_
- [x] Scaffold `apps/admin` — Next.js 15 — _verified 2026-09-25: `tsc`, ESLint, and `next build` pass. Admin had no standalone output, so `docker build --build-arg APP=admin` could never have worked — fixed_
- [x] Install and configure Tailwind 4 with the design tokens from Phase 2 as CSS custom properties — _tokens live in `packages/config/tailwind/tokens.css`, imported by both apps_
- [x] Install shadcn/ui; vendor in the primitives designed in Phase 2 — _2026-09-26: Button, Select, Checkbox, Dialog, Sheet, Toast (sonner), Skeleton in `apps/storefront/src/components/ui` (moves to `packages/ui` in Phase 10). shadcn colour names are mapped onto Velo tokens in `packages/config/tailwind/shadcn-bridge.css` — no second palette. Button rebuilt to §4 (six variants, 32/40/48/56px, 44px hit area, width-locked loading state); Toaster rebuilt to §4 (Velo `data-theme`, bottom-right/top-on-mobile, max three, `notify` enforces 4s/4s/6s/never). The CLI installed an unrelated npm package named `cn` and skipped `class-variance-authority`/`lucide-react` — replaced with a local `cn()` over `clsx` + `tailwind-merge`. 10 vitest tests. Select, Checkbox, Dialog, Sheet and Skeleton are stock shadcn restyled only through the token bridge; their §4 specifics (native select on mobile, 44px checkbox target, mobile bottom sheet, skeleton delay) land with the pages that use them._
- [x] Set up the root layout, theme provider (light/dark, system-aware, no flash of wrong theme), and font loading — _layout, no-flash theme script, and three-state theme toggle; fonts added 2026-09-26: Inter and JetBrains Mono via `next/font` in both apps (self-hosted, Latin subset, preloaded, `swap` — DESIGN-SYSTEM.md §7), feeding `--font-sans`/`--font-mono` in the shared tokens. `tsc`, ESLint, and `next build` pass for both apps_
- [x] Set up `packages/api-client` with OpenAPI → TypeScript generation wired to a pnpm script — _`packages/api-client` with `openapi-typescript` wired to `pnpm generate:api`; CI fails if the committed client is stale_ 12 vitest tests added for `formatMoney` (USD/JPY/KWD minor units, locale) and `isProblemDetail`. **Resolved 2026-09-27 — the client was not typed at all:** `schema.d.ts` was gitignored and had never been generated, and `createClient()` was called without `paths`, so every path and body was `any` and `tsc` could not notice the missing file. The CI freshness check could never fail either (`git diff` ignores untracked files). Now: `schema.d.ts` is committed and Prettier-ignored; `createClient<paths>`; a `Schema<"Name">` helper; `pnpm generate:api` runs `apps/api/scripts/export_openapi.py` (sorted, LF, no running API or database needed) and CI uses the same script; the walking-skeleton page uses the client instead of a hand-written interface. Checked by a negative test: an unknown path fails `tsc`.

### 3.4 Infrastructure & CI

- [x] Write `docker/docker-compose.dev.yml`: Postgres 16, Redis 7, Meilisearch, MailHog — _Postgres 16, Redis 7, Meilisearch, MailHog, with health checks and an extensions init script_
- [x] Write production Dockerfiles: multi-stage, non-root user, minimal base image — _`docker/api.Dockerfile` and `docker/web.Dockerfile` — multi-stage, non-root, cached dependency layers_ **API image verified 2026-09-26** — first run found it could never start (venv built in `/build`, run from `/app`; console-script shebangs pointed at `/build`). Fixed: build in `/app`, `--no-editable`. Smoke test: `/ready` 200 against the dev containers, JSON logs, Docker healthcheck `healthy`, runs as uid 1001, 308 MB. **Web image verified 2026-09-27** for both `APP=storefront` and `APP=admin` (326 MB each). Smoke test on the dev network: the storefront container renders `PostgreSQL 16.15` through the API container; admin serves 200. Found and fixed: the runtime user was in `nogroup`, not `nodejs` (busybox `adduser --system` needs `-G`). The build cost ~2 GB of host disk.
- [x] Set up pre-commit hooks: ruff, mypy, eslint, prettier, gitleaks — _verified 2026-09-26: all 15 hooks pass on every project file, including the gitleaks secret scan. ruff and mypy run as local `uv run` hooks (one version, one config with CI and the editor) instead of the pinned mirror repos. First-run hook environments need ~1.5 GB (gitleaks builds with Go). Until the first commit, `--all-files` checks nothing — use `pre-commit run --files $(git ls-files -o --exclude-standard)`. `pre-commit install` still to be run by the owner, since it changes `.git/hooks`._
- [x] Write the CI workflow: lint → type-check → test → build, on every PR — _`.github/workflows/ci.yml` — secret scan → API (lint, types, unit, integration) → web (client freshness, lint, types, tests, build) → images_
- [~] Verify the whole stack starts from a clean clone with the documented commands, on a machine that is not yours — _**On this machine it now runs end to end** (2026-09-26): containers → API → storefront renders `PostgreSQL 16.15` and the live database time. Following the README found two bugs, both fixed: the root `.env` was never read when the API runs from `apps/api`, and a host Postgres on 5432 silently intercepts the container (`VELO_POSTGRES_PORT` override added and documented). Still needed: a run on a second machine, from a fresh clone._

**Definition of Done — Phase 3 (M1):** A fresh clone reaches a running storefront, admin, and API in under 10 minutes using only the README. CI is green. The walking skeleton renders a value fetched from Postgres through the API in the browser.

---

# Phase 4 — Database & Migrations

_Schema is the hardest thing to change later. Get it right now. Full detail in `docs/DATA-MODEL.md`._

- [ ] Configure SQLAlchemy 2.0 async engine, session factory, and a FastAPI session dependency with correct transaction scoping
- [ ] Configure Alembic for async, with a naming convention for constraints (so autogenerate produces reviewable diffs)
- [ ] Implement the base model: UUIDv7 primary keys, `created_at`, `updated_at`, optional `deleted_at`
- [ ] Implement the `Money` type — `BIGINT` minor units + currency column, with a helper type decorator. **No floats anywhere.**
- [ ] Migration: identity — `users`, `sessions`, `refresh_tokens`, `addresses`, `roles`, `permissions`
- [ ] Migration: catalog — `products`, `product_variants`, `product_options`, `option_values`, `variant_option_values`, `categories`, `collections`, `product_media`, `reviews`
- [ ] Migration: inventory — `inventory_items`, `inventory_movements`, `inventory_reservations`
- [ ] Migration: cart — `carts`, `cart_items`
- [ ] Migration: checkout & orders — `checkout_sessions`, `orders`, `order_items`, `order_events`, `fulfilments`, `returns`, `return_items`
- [ ] Migration: payments — `payments`, `payment_events`, `refunds`, `idempotency_keys`
- [ ] Migration: commerce rules — `discounts`, `discount_redemptions`, `shipping_zones`, `shipping_rates`, `tax_rates`
- [ ] Migration: platform — `audit_log`, `outbox_events`, `webhook_deliveries`
- [ ] Add every index defined in `docs/DATA-MODEL.md`, including partial indexes on hot paths
- [ ] Add `CHECK` constraints: non-negative quantities, non-negative money, valid status values, `total = subtotal + tax + shipping - discount`
- [ ] Write the seed script: 50 products with variants and images, 3 collections, 5 discounts, an admin user, a demo customer with order history

**Definition of Done — Phase 4:** `alembic upgrade head` on an empty database produces the full schema; `alembic downgrade base` reverses it cleanly. Seed data loads. The ERD in `docs/DATA-MODEL.md` matches the migrations exactly.

---

# Phase 5 — Identity & Access

_Get auth wrong and nothing else matters._

- [ ] Password hashing with Argon2id at OWASP-recommended parameters
- [ ] `POST /auth/register` — email + password, with a strength policy and breach check against Have I Been Pwned's k-anonymity API
- [ ] Email verification: signed, single-use, expiring token
- [ ] `POST /auth/login` — issues a 15-minute access token and a 30-day refresh token, both in httpOnly, Secure, SameSite=Lax cookies
- [ ] `POST /auth/refresh` — **rotating** refresh tokens with reuse detection; a reused token revokes the entire family
- [ ] `POST /auth/logout` — revokes the refresh token server-side, not just client-side
- [ ] Password reset: request → emailed single-use token → set new password → revoke all sessions
- [ ] CSRF protection — double-submit cookie pattern, required because auth is cookie-based
- [ ] Rate limiting on all auth endpoints, per IP **and** per account, with exponential backoff
- [ ] Account lockout after N failed attempts, with a notification email
- [ ] RBAC: roles (`customer`, `fulfilment`, `staff`, `admin`, `owner`) and a permission dependency for route protection
- [ ] `get_current_user` / `get_current_admin` FastAPI dependencies
- [ ] Address book CRUD with a default shipping and billing address
- [ ] Storefront auth UI: login, register, forgot password, reset password, verify email
- [ ] Session management page: list active sessions with device and location, allow individual revocation
- [ ] Optional — OAuth via Google and Apple

**Definition of Done — Phase 5:** Full signup → verify → login → refresh → logout → reset cycle works. Refresh-token reuse is detected and kills the family. Auth endpoints are rate limited. Every branch of this flow has an integration test, including the failure branches.

---

# Phase 6 — Catalog & Search

_Milestone M2._

### 6.1 Catalog domain

- [ ] Product and variant models with the option/value matrix (Size × Colour → SKU)
- [ ] Category tree (nested set or `ltree`) and flat collections; a product may belong to many collections
- [ ] Media: S3/R2 presigned upload, automatic WebP/AVIF derivatives at responsive widths, blurhash placeholders
- [ ] Public catalog endpoints: list products with cursor pagination, filtering, and sorting; product detail by slug
- [ ] Admin catalog endpoints: full CRUD for products, variants, options, categories, collections, media
- [ ] Bulk CSV import/export with row-level validation and a dry-run mode
- [ ] Product reviews: submit, moderate, aggregate rating, verified-purchase badge
- [ ] Redis caching for product and collection reads, with event-driven invalidation on write

### 6.2 Inventory

- [ ] Inventory item per variant: `quantity_on_hand`, `quantity_reserved`, `reorder_point`
- [ ] Available-to-sell is a derived value: `on_hand - reserved`. Never stored, always computed.
- [ ] Inventory movements as an append-only ledger — every change has a reason and an actor
- [ ] Low-stock threshold alerting
- [ ] Back-in-stock subscription and notification

### 6.3 Search

- [ ] Meilisearch index configuration: searchable attributes, filterable facets, sortable fields, ranking rules, synonyms, stop words
- [ ] Indexing pipeline driven by the outbox — catalog writes enqueue an index job, never block on the search engine
- [ ] Search endpoint: query + facet filters + sort + pagination, with facet counts returned
- [ ] Autocomplete and search-suggestion endpoint
- [ ] Full reindex command, safe to run against production
- [ ] Graceful degradation: if Meilisearch is unreachable, fall back to Postgres full-text search rather than returning an error

**Definition of Done — Phase 6 (M2):** 1,000 seeded products are browsable, filterable, and searchable end to end. Search returns in under 50 ms at p95. Killing the Meilisearch container degrades search instead of breaking the site.

---

# Phase 7 — Cart & Pricing Engine

_The pricing engine is the highest-risk pure logic in the system. It is also the easiest to test exhaustively — so test it exhaustively._

- [ ] Cart model supporting both a guest cart (cookie-bound opaque token) and a user cart
- [ ] `POST /cart/items`, `PATCH /cart/items/{id}`, `DELETE /cart/items/{id}`, `GET /cart`
- [ ] **Cart merge on login** — combine guest and user carts, summing quantities, respecting stock limits, resolving conflicts deterministically
- [ ] **Server-side re-pricing on every mutation.** The client sends a variant ID and a quantity. Nothing else. Never a price.
- [ ] Line-item pricing: unit price, compare-at price, quantity, line subtotal
- [ ] Discount engine:
  - [ ] Code-based discounts and automatic discounts
  - [ ] Types: percentage off, fixed amount off, free shipping, buy-X-get-Y
  - [ ] Eligibility rules: minimum subtotal, specific products/collections, first-order-only, customer segment
  - [ ] Usage limits: total redemptions, per-customer redemptions, date window
  - [ ] Stacking rules — define precisely which discounts combine and in what order they apply
- [ ] Tax calculation service with a pluggable provider interface; a rules-based default implementation
- [ ] Shipping rate calculation: by zone, weight band, price band, free-over-threshold
- [ ] Deterministic total assembly with an explicit, documented rounding rule applied at a single point
- [ ] Cart validation on read: flag removed products, price changes, and stock shortfalls rather than silently mutating the cart
- [ ] Cart expiry and abandoned-cart marking
- [ ] **Property-based tests** (Hypothesis) on the pricing engine: totals are never negative, discounts never exceed subtotal, the sum of line totals plus tax plus shipping minus discount always equals the order total, and rounding never loses or invents a cent

**Definition of Done — Phase 7:** The pricing engine has 95%+ branch coverage plus property-based tests. Every discount type and stacking combination has a test. A client cannot influence any price.

---

# Phase 8 — Checkout & Payments

_Milestone M3 — the critical phase. Read `docs/PAYMENTS-AND-CHECKOUT.md` in full before starting. Nothing here is a place to move fast._

### 8.1 Checkout session

- [ ] `checkout_sessions` state machine: `initiated → address_set → shipping_set → payment_pending → confirmed` / `failed` / `expired` / `abandoned`
- [ ] Every transition validated server-side; illegal transitions rejected, not tolerated
- [ ] `POST /checkout` — create a session from a cart, snapshotting the priced cart into the session
- [ ] `PATCH /checkout/{id}/address` — set shipping and billing addresses, with validation and normalisation
- [ ] `PATCH /checkout/{id}/shipping` — select a shipping method from the calculated available rates
- [ ] Session TTL (30 minutes) with automatic expiry and reservation release

### 8.2 Inventory reservation — the oversell guard

- [ ] Reserve stock inside the checkout-creation transaction, using `SELECT ... FOR UPDATE` on the inventory row
- [ ] Reservations carry a TTL tied to the checkout session
- [ ] Background sweeper releases expired reservations and returns the stock
- [ ] Reservation converts to a permanent inventory movement on payment confirmation
- [ ] **Dedicated concurrency test suite**: N simultaneous checkouts against 1 unit of stock must produce exactly 1 order and N-1 clean "out of stock" responses. Run it at N = 2, 10, and 100.

### 8.3 Payment abstraction

- [ ] Define the `PaymentProvider` protocol: `create_intent`, `capture`, `refund`, `verify_webhook`, `get_status`
- [ ] Implement the Stripe adapter
- [ ] Implement the Paystack/Flutterwave adapter against the same protocol
- [ ] Provider selection by currency, region, or configuration

### 8.4 Payment flow

- [ ] `POST /checkout/{id}/payment-intent` — **recompute the total from the database**, then create the provider intent for that amount. The amount sent to the provider is never taken from the request body.
- [ ] Idempotency middleware: `Idempotency-Key` header required on all money-moving POSTs; the `idempotency_keys` table stores request fingerprint and response, and replays return the stored response
- [ ] Store the payment record in `payment_pending` before calling the provider, so a crash mid-call is recoverable
- [ ] Frontend integration with Stripe Payment Elements — cards, Apple Pay, Google Pay, Link
- [ ] 3-D Secure / SCA handled entirely inside the provider's element; confirm no card data ever reaches our origin

### 8.5 Webhooks — where orders actually get created

- [ ] `POST /webhooks/stripe` — **verify the HMAC signature against the raw request body before parsing anything**
- [ ] Persist every webhook to `payment_events` keyed by the provider's event ID; a duplicate event ID is acknowledged and dropped
- [ ] Return `200` immediately, process asynchronously — providers retry aggressively on slow responses
- [ ] Handle `payment_intent.succeeded` → convert reservation to a sale, create the order, send confirmation
- [ ] Handle `payment_intent.payment_failed` → release the reservation, notify the customer, keep the cart intact
- [ ] Handle `charge.refunded`, `charge.dispute.created`
- [ ] Out-of-order event handling: a `succeeded` event arriving after a `failed` event for the same intent must resolve correctly
- [ ] Dead-letter queue for webhooks that fail processing, with alerting and a manual replay tool
- [ ] **Reconciliation job** — every 15 minutes, query the provider for intents in a non-terminal state older than 30 minutes and settle them. This is the safety net for lost webhooks.

### 8.6 Order creation

- [ ] Create the order **atomically** in the webhook handler: order + line items + inventory movement + payment record, in one transaction
- [ ] Snapshot into every line item: product title, variant title, SKU, unit price, tax rate, discount applied. A later catalog edit must never alter a historical order.
- [ ] Generate a human-readable order number (not the UUID, not a sequential integer that leaks volume)
- [ ] Emit the `order.created` event via the outbox for email and analytics
- [ ] Clear the cart only after the order is committed

**Definition of Done — Phase 8 (M3):** A test card completes a full purchase end to end. The concurrency suite passes at N=100. Replaying a webhook creates no second order. Killing the API between intent creation and webhook delivery still results in a correct order once reconciliation runs. **Every one of these is tested, not assumed.**

---

# Phase 9 — Orders, Fulfilment & Returns

- [ ] Order status machine: `pending → paid → processing → partially_fulfilled → fulfilled → delivered`, plus `cancelled` and `refunded`
- [ ] `order_events` as an immutable audit trail — every status change records actor, timestamp, and reason
- [ ] Customer order endpoints: list, detail, track, cancel (only while cancellable)
- [ ] Admin order endpoints: list with filters, detail, transition status, add internal notes
- [ ] Fulfilment: create a fulfilment against selected line items, attach carrier and tracking number, support partial fulfilment
- [ ] Shipment tracking integration (carrier API or webhook), with customer-facing status
- [ ] Cancellation: allowed pre-fulfilment; restores inventory, triggers a full refund
- [ ] Refunds:
  - [ ] Full and partial, at line-item granularity
  - [ ] Validated against the captured amount — cumulative refunds can never exceed it
  - [ ] Idempotent, via the same key mechanism as payments
  - [ ] Recorded in the refund ledger with a reason code
- [ ] Returns / RMA: customer request → admin approval → return label → receipt at warehouse → refund
- [ ] Restocking decision on return receipt (restock vs write off as damaged)
- [ ] Invoice PDF generation and email delivery
- [ ] Packing slip generation for fulfilment staff
- [ ] Order search by number, customer email, or SKU

**Definition of Done — Phase 9:** An operator can take an order from paid to delivered, process a partial return, and issue a partial refund — entirely through the API, never touching the database. Every transition is in the audit trail.

---

# Phase 10 — Storefront UI

_Milestone M4 begins. This is where the design from Phase 2 becomes real._

### 10.1 Shell

- [ ] Root layout: header with search and cart, mega-nav, footer, mobile nav drawer
- [ ] Theme toggle with no flash of incorrect theme on first paint
- [ ] Global loading, error, and 404 boundaries
- [ ] Toast system for feedback on every mutation
- [ ] Skip-to-content link and a visible, high-contrast focus ring throughout

### 10.2 Discovery

- [ ] Home page: hero, featured collections, new arrivals, editorial blocks — server-rendered
- [ ] Collection and category listing: filter sidebar (desktop) / filter sheet (mobile), sort control, responsive grid
- [ ] Filters reflected in the URL so results are shareable and back/forward behave correctly
- [ ] Infinite scroll or "load more" with a working, accessible fallback
- [ ] Search overlay with debounced instant results, keyboard navigation, and recent searches
- [ ] Product card: image with hover state, title, price with compare-at, rating, quick-add, wishlist toggle

### 10.3 Product detail

- [ ] Image gallery: thumbnails, zoom, swipeable on mobile, lazy-loaded below the fold
- [ ] Variant selector reflecting real availability — unavailable combinations are visibly disabled, not silently broken
- [ ] Live stock indicator ("Only 3 left")
- [ ] Add to cart with optimistic UI and rollback on failure
- [ ] Description, specifications, shipping and returns info in accessible accordions
- [ ] Reviews with distribution summary, pagination, and a submission form
- [ ] Related and recently viewed products
- [ ] Full structured data (`Product`, `Offer`, `AggregateRating`) for rich search results

### 10.4 Cart & checkout

- [ ] Cart drawer (quick view) and a full cart page
- [ ] Quantity stepper with optimistic update, stock cap, and debounced server sync
- [ ] Discount code entry with clear success and failure messaging
- [ ] Order summary that updates live and shows exactly how the total was reached
- [ ] Checkout: a four-step flow with a persistent progress indicator, resumable if the customer navigates away
- [ ] Address form with autocomplete, per-country field layouts, and inline validation
- [ ] Shipping method selection with prices and delivery estimates
- [ ] Payment step with Stripe Payment Elements, express wallet buttons surfaced first
- [ ] Review step showing the final, authoritative total before the customer commits
- [ ] Order confirmation page with full order detail and next steps
- [ ] **Checkout error handling** — card declined, network failure, session expired, stock lost during checkout. Every one has a designed, recoverable state. Never a blank screen, never a raw error.

### 10.5 Account

- [ ] Order history and order detail with tracking
- [ ] Address book management
- [ ] Profile and password settings
- [ ] Wishlist
- [ ] Return request flow

**Definition of Done — Phase 10:** Every page works at 320px and at 2560px, in both themes, with a keyboard alone, and with a screen reader. Every error path from 10.4 has been manually exercised.

---

# Phase 11 — Admin Dashboard

- [ ] Admin shell: sidebar navigation, breadcrumbs, command palette (⌘K), role-aware menu
- [ ] Dashboard: revenue chart, order count, AOV, conversion funnel, low-stock alerts, recent orders
- [ ] Product list: server-side pagination, search, filters, bulk actions
- [ ] Product editor: details, variant matrix builder, media manager with drag-to-reorder, SEO fields, publish/unpublish
- [ ] Inventory view: stock levels across variants, inline adjustment with mandatory reason, movement history
- [ ] Bulk CSV import with column mapping, validation preview, and dry-run before commit
- [ ] Order list: filter by status, date range, and value; saved views
- [ ] Order detail: full timeline, customer info, line items, payment and refund history, fulfilment actions, internal notes
- [ ] Fulfilment workflow: select items, enter carrier and tracking, print packing slip
- [ ] Refund modal: per-line-item selection, reason code, live preview of the refund amount, confirmation step
- [ ] Return/RMA queue with approve and reject actions
- [ ] Customer list and profile: order history, lifetime value, addresses, notes
- [ ] Discount builder with live rule preview and an eligibility tester
- [ ] Analytics: revenue over time, top products, conversion funnel, cohort retention, CSV export
- [ ] Settings: store details, shipping zones and rates, tax rates, email templates, payment providers
- [ ] Staff management: invite, assign role, revoke access
- [ ] Audit log viewer with filtering by actor, entity, and date
- [ ] Optimistic updates with rollback throughout; no full-page reloads on mutation

**Definition of Done — Phase 11 (M4):** An operator with no SQL access can run the entire store: add products, manage stock, fulfil orders, issue refunds, create discounts, and read performance.

---

# Phase 12 — Notifications & Background Jobs

- [ ] ARQ worker setup with queue definitions, retry policy, and exponential backoff
- [ ] Outbox pattern: domain events written in the same transaction as the state change, relayed by a poller. No lost events, no dual-write inconsistency.
- [ ] Email templates in React Email: order confirmation, shipping notification, delivery confirmation, refund issued, password reset, email verification, welcome, back-in-stock, abandoned cart
- [ ] Resend integration with delivery-status webhook handling
- [ ] Abandoned-cart recovery: scheduled sequence at 1 hour, 24 hours, and 72 hours, with a single-click unsubscribe
- [ ] Scheduled jobs: reservation sweeper, payment reconciliation, search reindex, low-stock check, nightly analytics rollup
- [ ] Job failure alerting and a dead-letter queue with a replay tool
- [ ] Email preview route in development so templates can be reviewed without sending
- [ ] Per-customer notification preferences, honoured by every sender
- [ ] Rate limiting on outbound email per recipient
- [ ] All transactional emails render correctly in Gmail, Outlook, and Apple Mail, and have a readable plain-text alternative
- [ ] Worker health check and queue-depth metric exported to monitoring

**Definition of Done — Phase 12:** Every customer-facing event sends the right email exactly once. Jobs retry on failure and alert when they exhaust retries. No event is lost if the worker is down.

---

# Phase 13 — Testing & QA

_Much of this is written alongside earlier phases. This phase is where coverage is closed out and the gates are enforced._

- [ ] pytest configured with async support, testcontainers Postgres, and per-test transaction rollback
- [ ] Factory fixtures for every domain entity
- [ ] Unit tests: pricing engine, discount rules, tax, shipping, all state machines
- [ ] Property-based tests on money arithmetic and total assembly
- [ ] Integration tests covering every API endpoint, including auth failures and validation errors
- [ ] **Concurrency test suite**: simultaneous checkouts, simultaneous cart mutations, simultaneous discount redemptions against a usage limit
- [ ] **Webhook test suite**: duplicates, out-of-order delivery, invalid signatures, malformed payloads, replay attacks
- [ ] Contract tests via schemathesis against the OpenAPI schema
- [ ] Vitest + Testing Library for components, hooks, and form validation
- [ ] MSW for frontend API mocking
- [ ] Playwright E2E on Chromium, Firefox, and WebKit:
  - [ ] Guest purchase, full journey
  - [ ] Registered purchase with a saved address
  - [ ] Discount code applied at checkout
  - [ ] Card declined, then retried successfully
  - [ ] Out-of-stock encountered during checkout
  - [ ] Return and refund, end to end
- [ ] axe-core accessibility assertions on every page in the Playwright suite
- [ ] k6 load test: 500 concurrent checkouts, asserting p95 latency and zero oversells
- [ ] Coverage gates enforced in CI: 85% backend, 75% frontend — the build fails below them
- [ ] Manual QA pass on real devices: iOS Safari, Android Chrome, desktop Safari

**Definition of Done — Phase 13:** CI runs the full suite on every PR and blocks merge on failure. All six E2E journeys pass on all three browsers. Zero axe violations.

---

# Phase 14 — Performance & SEO

- [ ] Establish the performance budget in CI (Lighthouse CI) and fail the build when it regresses
- [ ] Database: review `EXPLAIN ANALYZE` for every hot query; eliminate all N+1 queries with eager loading
- [ ] Redis caching for catalog reads with event-driven invalidation
- [ ] Next.js caching strategy per route: static, ISR, or dynamic — decided deliberately, not by default
- [ ] Image optimisation: AVIF/WebP, responsive `srcset`, lazy loading below the fold, blurhash placeholders, explicit dimensions to prevent CLS
- [ ] Bundle analysis; code-split heavy routes; defer non-critical third-party scripts
- [ ] Font loading with `font-display: swap` and preloaded subsets
- [ ] Preconnect to the CDN and payment provider origins
- [ ] API response compression and `ETag`/conditional-request support
- [ ] SEO: per-page metadata, Open Graph, Twitter cards, canonical URLs
- [ ] `sitemap.xml` generated from the live catalog, and `robots.txt`
- [ ] JSON-LD structured data: `Product`, `Offer`, `AggregateRating`, `BreadcrumbList`, `Organization`
- [ ] Verify Core Web Vitals against the Phase 0 budget on a throttled mid-range mobile profile — not on a fast laptop

**Definition of Done — Phase 14:** Lighthouse ≥ 95 on performance, accessibility, best practices, and SEO for home, category, and product pages. CWV budgets hold on simulated 4G.

---

# Phase 15 — Security Hardening

- [ ] Full OWASP Top 10 review with findings documented and closed
- [ ] Verify server-side authorisation on **every** endpoint — the most common real-world breach is a missing ownership check, not a clever exploit
- [ ] Test for IDOR: attempt to read and mutate another user's cart, order, address, and payment
- [ ] Confirm SQL injection is impossible — parameterised queries only, no string-built SQL anywhere
- [ ] XSS review: no `dangerouslySetInnerHTML` on unsanitised input; all user content escaped
- [ ] CSRF protection verified on every state-changing endpoint
- [ ] Security headers: CSP (no `unsafe-inline`), HSTS with preload, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`
- [ ] Rate limiting tuned per endpoint class; abuse detection on auth and checkout
- [ ] Input validation at the boundary on every request; strict size limits on bodies and uploads
- [ ] File upload security: content-type sniffing, magic-byte validation, size caps, serve from a separate origin
- [ ] Secrets audit: nothing in the repository, nothing in logs, nothing in error responses. gitleaks in CI.
- [ ] PII handling: encrypt sensitive fields at rest, redact PII from logs, implement data export and erasure endpoints
- [ ] **Confirm PCI-DSS SAQ-A scope**: prove by inspection that no card data touches our servers or logs
- [ ] Dependency audit: `pip-audit`, `pnpm audit`, Trivy on images — automated and scheduled, not one-off
- [ ] Penetration test of the checkout and payment flow specifically
- [ ] Write the incident response runbook: detection, containment, communication, recovery, postmortem

**Definition of Done — Phase 15:** No high or critical findings open. Security headers score A on securityheaders.com. IDOR and price-tampering attempts are provably rejected, with tests demonstrating it.

---

# Phase 16 — Observability

- [ ] Structured JSON logging across all services with a correlation ID propagated from frontend through API to worker
- [ ] Sentry for both backend and frontend, with source maps and release tagging
- [ ] OpenTelemetry tracing across API → database → external calls
- [ ] Prometheus metrics: request rate, error rate, latency histograms, queue depth, DB pool saturation
- [ ] **Business metrics as first-class telemetry**: orders/hour, revenue/hour, checkout conversion, payment failure rate, cart abandonment
- [ ] Grafana dashboards: system health, business health, payment health
- [ ] Alerting with defined thresholds and escalation:
  - [ ] Error rate > 1% for 5 minutes
  - [ ] p95 latency > 500 ms for 5 minutes
  - [ ] Payment failure rate > 5%
  - [ ] Webhook dead-letter queue non-empty
  - [ ] **Zero orders in 30 minutes during business hours** — the single most valuable alert you will have
- [ ] Uptime monitoring on the storefront, API, and a synthetic checkout
- [ ] Log retention and query tooling
- [ ] On-call runbook: what each alert means, and the first three things to check

**Definition of Done — Phase 16:** You learn about an outage from an alert, not from a customer. Any order can be traced end to end from a single correlation ID.

---

# Phase 17 — Deployment & Launch

### 17.1 Infrastructure

- [ ] Provision production: Postgres (Neon or RDS), Redis, Meilisearch, S3/R2
- [ ] Provision staging as a true production mirror — same versions, same topology, smaller instances
- [ ] Secrets in the platform secret manager; verified absent from the repository and from logs
- [ ] Custom domains with TLS; HSTS preload submitted
- [ ] CDN configured with correct cache rules per route
- [ ] PgBouncer connection pooling in front of Postgres

### 17.2 Pipeline

- [ ] CD: merge to `main` → staging; tagged release → production, gated on manual approval
- [ ] Database migrations run as a separate, reviewable step before the application deploy
- [ ] Zero-downtime deploys: health-checked rolling release
- [ ] **Rollback tested, not assumed** — practise a full rollback on staging and time it
- [ ] Automated backups with PITR; **restore drill performed and documented**. An untested backup is not a backup.

### 17.3 Launch readiness

- [ ] Stripe account moved to live mode; live webhook endpoint registered and verified
- [ ] Real payment methods tested with a small live transaction, then refunded
- [ ] Tax and shipping configuration verified against the real business rules
- [ ] Legal pages published: terms, privacy policy, refund policy, cookie policy
- [ ] Cookie consent implemented where legally required
- [ ] Analytics installed (privacy-respecting), conversion tracking verified
- [ ] Load test against staging at expected launch peak × 3
- [ ] Final full E2E pass against staging with real payment credentials
- [ ] **Go/no-go checklist** reviewed and signed off
- [ ] Launch-day runbook: who watches what, what the rollback trigger is, who makes the call

**Definition of Done — Phase 17 (M6):** Production is live, monitored, backed up, and rollback-tested. A real customer can buy a real product with a real card.

---

# Phase 18 — Post-Launch

- [ ] Daily monitoring review for the first two weeks
- [ ] Weekly review of conversion funnel drop-off; prioritise the biggest leak
- [ ] Customer feedback collection and triage process
- [ ] Bug triage SLA: critical within 4 hours, high within 24 hours, medium within a week
- [ ] Monthly dependency updates and security patching
- [ ] Quarterly database maintenance: index review, `VACUUM`/`ANALYZE` tuning, slow-query audit
- [ ] Quarterly disaster-recovery drill
- [ ] Postmortem process for every incident — blameless, written, actioned
- [ ] Track and revisit the backlog of items descoped from v1
- [ ] Revisit the scaling checklist when traffic doubles

---

## Backlog — explicitly out of scope for v1

Recorded so they are decisions rather than omissions.

- Multi-vendor marketplace
- Subscriptions and recurring billing
- Multi-currency pricing with localised rates (v1 is single-currency)
- Multi-warehouse inventory and fulfilment routing
- B2B: quotes, purchase orders, net terms, customer-specific pricing
- Loyalty points and store credit
- Gift cards
- Native mobile apps
- Headless CMS integration for editorial content
- A/B testing framework
- Advanced personalisation and recommendation engine
- ERP/accounting integration
- POS integration

---

## Change log

| Date       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | By     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 2026-09-20 | Initial plan created. 19 phases.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Claude |
| 2026-09-24 | **Phase 0 closed** (13/14; the per-phase register review is standing). `docs/DISCOVERY.md` written; the inline risk register moved there and expanded from 7 to 15 risks with exposure ratings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Claude |
| 2026-09-24 | **Phase 1 closed** (12/12). `docs/adr/` created with an index, a template, and ADR-001 … ADR-010 in full. `docs/ARCHITECTURE.md` §10 now resolves to real files.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Claude |
| 2026-09-24 | **Phase 2 at 9/17.** Tokens, contrast, type, breakpoints, motion, state doctrine, checkout friction, and the accessibility pass are specified in `docs/DESIGN-SYSTEM.md`. Outstanding: the remaining primitives and commerce components, account and admin pages, and the clickable checkout prototype.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Claude |
| 2026-09-24 | Progress table recounted against the actual checkboxes: **326 tasks, not 301.** Ten phases were miscounted, Phases 8 and 10 most heavily. Estimates unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Claude |
| 2026-09-24 | **Phase 3 written end to end**, and **not executed**: monorepo layout, legacy files archived to `legacy/`, shared config package with the design tokens, FastAPI skeleton (app factory, typed settings, JSON logging with correlation IDs, RFC-9457 errors, `/health` and `/ready`, a walking-skeleton route reading Postgres through a service and repository), unit tests, both Next.js apps, the typed API client, dev containers, production Dockerfiles, pre-commit hooks, and CI. Verification is blocked by a full disk.                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Claude |
| 2026-09-24 | **Phase 2 to 16/17.** Remaining primitives and commerce components specified in `docs/DESIGN-SYSTEM.md` §4, with a per-component state matrix. `docs/PAGE-SPECS.md` written: storefront, account, and admin pages with a mobile coverage checklist. Only the clickable checkout prototype remains.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Claude |
| 2026-09-25 | **Phase 3 to 17/24 — API skeleton verified.** Disk freed enough for `uv sync`. First execution found and fixed: a startup crash on comma-separated `VELO_CORS_ORIGINS` (pydantic-settings JSON-decodes env lists — now `NoDecode`, with a regression test), a 500-handler test that let the transport re-raise, a deprecated Starlette 422 constant, 6 ruff issues, and 8 stale `type: ignore`s. `pydantic-settings` floor raised to 2.7. Integration tests, containers, and both frontends remain unexecuted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Claude |
| 2026-09-25 | **Phase 3 to 19/24 — web verified.** `pnpm install` ran (the link is now ~1.8 MB/s). First execution of the frontend found and fixed: `eslint` not reachable from the apps under pnpm's strict layout, `prettier-plugin-tailwindcss` referenced but not installed, `@types/node` missing in api-client, no ESLint config in api-client, type-aware lint failing on `.mjs` files, the Next ESLint plugin never loaded (swapped `eslint-config-next` for `@next/eslint-plugin-next`), and a relative `outputFileTracingRoot`. Docker fixes found by reading, not running: no `.dockerignore` (the build would have copied host `node_modules`, `.venv`, and `.env` into images, and overwritten the API image's Linux venv with the Windows one), workspace-package `node_modules` not copied into the web builder, and no standalone output for admin. Standalone output is now opt-in via `NEXT_OUTPUT_STANDALONE=1`. Whole repo run through Prettier; `.prettierignore` added. | Claude |
| 2026-09-26 | **Phase 3 to 20/24 — M1 skeleton runs end to end.** Docker came up; integration tests pass against real Postgres and Redis, and the storefront renders the Postgres version and time through the API. Found and fixed on the way: a host Postgres on 5432 intercepting the container (ports now `VELO_POSTGRES_PORT`/`VELO_REDIS_PORT`, tests take `VELO_TEST_DATABASE_URL`), the root `.env` never read when the API runs from `apps/api` (now reads `../../.env` then `.env`; regression test added, and the missing-settings test isolated from real `.env` files), and `database_time` shipped as a naive timestamp despite DATA-MODEL.md §1 (now `AwareDatetime`, ISO 8601 with offset; asserted in the integration test).                                                                                                                                                                                                                                                 | Claude |
| 2026-09-26 | **Phase 3 to 21/24 — fonts loaded.** Inter and JetBrains Mono via `next/font`; both apps build with no warnings, which also confirms the absolute `outputFileTracingRoot` and the Next ESLint plugin fix. Stopped on disk again: C: fell to ~90 MB with nothing of this project running. Cause: `pagefile.sys` is dynamically sized (17.4 GB, grown during builds) and `hiberfil.sys` holds 6.4 GB; the Docker WSL disk is 6.3 GB, ~3.3 GB of it another project's Supabase images. Remaining Phase 3 work (shadcn/ui, image builds, pre-commit) waits on the owner freeing space.                                                                                                                                                                                                                                                                                                                                                                                              | Claude |
| 2026-09-26 | **Phase 3 to 22/24 — shadcn/ui vendored, API image verified.** Seven primitives in the storefront behind a token bridge; Button and Toaster rebuilt to DESIGN-SYSTEM.md §4 with 10 tests. The API image had never been able to start (venv path mismatch) — fixed and smoke-tested. Pre-commit Python hooks now run through uv. The web image build filled C: to 0 MB (Docker's disk grew 6.3 → 10 GB) and was stopped; Docker was left unresponsive and the dev containers could not be stopped cleanly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Claude |
| 2026-09-26 | **Phase 3 to 23/24 — pre-commit verified.** All 15 hooks pass. Hibernation disabled by the owner (+6.4 GB). The web image is still unbuilt: Docker Desktop's engine did not recover from the full disk, and a scripted restart left it stopped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Claude |
| 2026-09-27 | **Phase 3 — web images verified; typed client made real.** Storefront and admin images build and serve; the storefront container renders Postgres data through the API container. Fixed the runtime group (`nogroup` → `nodejs`). Resolving the `schema.d.ts` contradiction found the "typed" client was untyped (`createClient` without `paths`, schema never generated) and the CI stale-client check a no-op. Added `scripts/export_openapi.py`, committed the schema, switched the skeleton page to the client, and corrected `pnpm generate:client` → `generate:api` in README.md and API-SPEC.md. Still 23/24: only the second-machine clean-clone run remains, plus a first CI run once the repository has a remote.                                                                                                                                                                                                                                                     | Claude |
