# Velo Commerce — Build Plan & Task Board

> **This is the working document.** Every task below has a checkbox. Tick it when the task meets its Definition of Done. Update the progress table at the top as phases complete.
>
> **Last updated:** 2026-10-05
> **Current phase:** Phase 3 — Foundation & Dev Environment (23/24: a clean-clone run on a second machine and a first green CI run on GitHub remain). Phase 2 is 17/17; its checkout prototype timing requirement was accepted as a documented retrospective deviation after a complete browser walkthrough of the implemented flow using sandbox payment (no real charge). **Phase 13 is 13/15:** frontend unit tests with MSW (≈1,270, coverage gates), the six Playwright journeys on three browsers with zero axe violations, schemathesis contract tests on every operation, webhook and concurrency suites, a sandbox payment provider for E2E and load tests, and coverage gates (backend 89%). Left: the k6 run's p95 under a one-SKU rush, and a manual pass on real devices. **Phase 12 is 11/12:** customer email is templated, sent exactly once per event, retried on failure, tracked to delivery through Resend, and rate-limited; abandoned carts get a 1/24/72-hour sequence with one-click unsubscribe; jobs back off, dead-letter and alert; the worker reports its heartbeat and queue depth. Left: proving rendering in real inboxes. **Phase 11 is built (18/18):** the admin covers products, stock, orders, refunds, returns, customers, discounts, analytics, settings, staff and the audit log, role-aware throughout; an operator's walk-through in a browser closes M4. **Phase 10 is built (35/35):** the storefront has its shell (mega-nav, search overlay, cart drawer, footer, error boundaries), listings with URL filters, the full product page with gallery, reviews and structured data, the checkout, and the account area — orders with per-parcel tracking, cancellation, returns, wishlist; it closes after a manual pass at 320 px / 2560 px, in both themes, by keyboard and with a screen reader. **Phase 9 is complete (13/13):** an operator can take an order from paid to delivered, ship it in parts, cancel it before shipping, process a partial return, and refund lines, shipping or goodwill — all through the API, bounded by the capture ledger, idempotent, and in the audit trail. **Phase 8 is built (34/34):** the storefront has the cart, the four-step checkout with the Stripe Payment Element (Paystack for African currencies), and the confirmation page; M3's live test-card purchase is the one check left, and it needs Stripe test keys in `.env`. Phase 7 is complete: the pricing engine has 100% branch coverage and Hypothesis property tests, every discount type and stacking combination is tested, and no request can carry a price. Phase 6 is complete (19/19, milestone M2): 1,000 seeded products are browsable, filterable and searchable; search p95 is 15 ms; stopping Meilisearch degrades search to Postgres. Phase 5 is complete (15/16; only the optional OAuth task is open): the full signup → verify → login → refresh → logout → reset cycle works through the API and in the browser. Phase 4 is complete (15/15): the full schema migrates up and down, matches the models exactly, and seeds. Phases 0 and 1 are complete.

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

| #   | Phase                           |   Tasks |    Done | Status                                       | Est.          |
| --- | ------------------------------- | ------: | ------: | -------------------------------------------- | ------------- |
| 0   | Discovery & Definition          |      14 |      13 | ✅ Done — 1 standing                         | 3 d           |
| 1   | Architecture & Decisions        |      12 |      12 | ✅ Done                                      | 3 d           |
| 2   | UX & Visual Design              |      17 |      17 | ✅ Done — retrospective walkthrough accepted | 5 d           |
| 3   | Foundation & Dev Environment    |      24 |      23 | 🚧 1 left — clean-clone run on a 2nd machine | 4 d           |
| 4   | Database & Migrations           |      15 |      15 | ✅ Done                                      | 4 d           |
| 5   | Identity & Access               |      16 |      15 | ✅ Done — OAuth (optional) not started       | 5 d           |
| 6   | Catalog & Search                |      19 |      19 | ✅ Done                                      | 7 d           |
| 7   | Cart & Pricing Engine           |      12 |      12 | ✅ Done                                      | 5 d           |
| 8   | Checkout & Payments             |      34 |      34 | ✅ Built — live card run needs Stripe keys   | 10 d          |
| 9   | Orders, Fulfilment & Returns    |      13 |      13 | ✅ Done                                      | 6 d           |
| 10  | Storefront UI                   |      35 |      35 | 🚧 Built — manual viewport/a11y pass left    | 12 d          |
| 11  | Admin Dashboard                 |      18 |      18 | 🚧 Built — operator browser pass left        | 10 d          |
| 12  | Notifications & Background Jobs |      12 |      11 | 🚧 1 left — inbox rendering check            | 4 d           |
| 13  | Testing & QA                    |      15 |      13 | 🚧 2 left — k6 p95, real devices             | 6 d           |
| 14  | Performance & SEO               |      13 |      10 | 🚧 3 left — ISR, Lighthouse run, CWV         | 4 d           |
| 15  | Security Hardening              |      16 |       0 | 🔜 Not started                               | 5 d           |
| 16  | Observability                   |      10 |       0 | 🔜 Not started                               | 3 d           |
| 17  | Deployment & Launch             |      21 |       0 | 🔜 Not started                               | 5 d           |
| 18  | Post-Launch                     |      10 |       0 | 🔜 Not started                               | ongoing       |
|     | **Total**                       | **326** | **203** | **62%**                                      | **~19 weeks** |

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
- [x] Prototype and click through the full checkout flow before any of it is coded — _Accepted 2026-10-05 as a documented retrospective deviation: because the checkout was already implemented, the complete flow was walked through in the VS Code browser against the isolated `velo_e2e` stack (product → cart → contact → delivery → shipping → sandbox payment → order confirmation). No real charge was made. This verifies the implemented journey, not pre-code prototyping._

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

- [x] Configure SQLAlchemy 2.0 async engine, session factory, and a FastAPI session dependency with correct transaction scoping — _`velo/db/session.py`: one engine per process, `get_session` per request (the service owns the commit), and `session_scope()` for scripts and jobs (commit on success, roll back on error)_
- [x] Configure Alembic for async, with a naming convention for constraints (so autogenerate produces reviewable diffs) — _`apps/api/alembic.ini` + `migrations/env.py`, URL from `VELO_DATABASE_URL`; one transaction per run; `pk_`/`fk_`/`uq_`/`ix_`/`ck_<table>_<name>` convention in `velo/db/base.py`. `uv run alembic check` reports no drift. The full-text expression index is excluded from that comparison (Postgres stores it normalised, which Alembic cannot match) and asserted by its own test_
- [x] Implement the base model: UUIDv7 primary keys, `created_at`, `updated_at`, optional `deleted_at` — _`HasId`, `HasCreatedAt`, `HasTimestamps`, `SoftDeletable` mixins. Postgres 16 has no `uuidv7()`: IDs are generated in Python (`velo/db/ids.py`, monotonic within a millisecond), and migration 0001 defines a SQL `uuidv7()` for rows inserted outside the ORM_
- [x] Implement the `Money` type — `BIGINT` minor units + currency column, with a helper type decorator. **No floats anywhere.** — _`velo/core/money.py` (value object; refuses floats, `Decimal`, `bool`, and mixed currencies) and `MinorUnits` in `velo/db/types.py`, which raises if a non-int is bound to a money column by any ORM path. A unit test sweeps every model: every `*_amount` column is `MinorUnits`, no column is a float_
- [x] Migration: identity — `users`, `refresh_tokens`, `addresses` — _`0002`. **Not tables, by design:** `roles`/`permissions` (five fixed roles in `users.role`, permissions mapped in code in Phase 5) and `sessions` (a session is a refresh-token family, ADR-008). DATA-MODEL.md §3 records why_
- [x] Migration: catalog — `products`, `product_variants`, `product_options`, `option_values`, `variant_option_values`, `categories`, `collections`, `product_media`, `reviews` — _`0003`, plus the `product_collections` join table. `reviews.order_id` gets its foreign key in `0006`, once `orders` exists_
- [x] Migration: inventory — `inventory_items`, `inventory_movements`, `inventory_reservations` — _`0007`, after checkout, because reservations reference checkout sessions_
- [x] Migration: cart — `carts`, `cart_items` — _`0005`_
- [x] Migration: checkout & orders — `checkout_sessions`, `orders`, `order_items`, `order_events`, `fulfilments`, `returns`, `return_items` — _`0006`, plus `fulfilment_items` and `discount_redemptions` (which references `orders`)_
- [x] Migration: payments — `payments`, `payment_events`, `refunds`, `idempotency_keys` — _`0008`_
- [x] Migration: commerce rules — `discounts`, `discount_redemptions`, `shipping_zones`, `shipping_rates`, `tax_rates` — _`0004`, ahead of checkout, which references discounts and shipping rates_
- [x] Migration: platform — `audit_log`, `outbox_events`, `webhook_deliveries` — _`0009`_
- [x] Add every index defined in `docs/DATA-MODEL.md`, including partial indexes on hot paths — _all of them, with the documented names. **Spec fix:** `idx_discounts_active` had `now()` in its predicate, which Postgres rejects; the predicate is now `is_active` and the date window belongs to the query_
- [x] Add `CHECK` constraints: non-negative quantities, non-negative money, valid status values, `total = subtotal + tax + shipping - discount` — _every documented CHECK, plus `>= 0` on the order and order-item discount, shipping, and tax amounts. `tests/integration/test_constraints.py` attempts each §13 invariant against the migrated schema and asserts Postgres rejects it by constraint name_
- [x] Write the seed script: 50 products with variants and images, 3 collections, 5 discounts, an admin user, a demo customer with order history — _`python -m velo.scripts.seed [--reset]`, or `pnpm db:seed` / `pnpm db:reset`. 50 products, 618 variants with option matrices, stock and images; categories as an `ltree`; shipping and tax rates; `admin@velo.dev` and `customer@velo.dev` (password `ChangeMe123!`, Argon2id); three orders with payments, fulfilments, events, and reviews. Deterministic, refuses production, and consistent: the ledger sums to stock on hand and every paid order has a captured payment (tested)_

**Verified 2026-09-28** on the development machine: `alembic upgrade head` on an empty database, `alembic downgrade base` back to nothing (tables, function, and extensions gone), `alembic check` clean, and the seed loaded. API: ruff, ruff format, and mypy strict clean; 270 tests pass, 26 of them integration against real Postgres and Redis.

**Definition of Done — Phase 4:** `alembic upgrade head` on an empty database produces the full schema; `alembic downgrade base` reverses it cleanly. Seed data loads. The ERD in `docs/DATA-MODEL.md` matches the migrations exactly.

---

# Phase 5 — Identity & Access

_Get auth wrong and nothing else matters._

- [x] Password hashing with Argon2id at OWASP-recommended parameters
- [x] `POST /auth/register` — email + password, with a strength policy and breach check against Have I Been Pwned's k-anonymity API
- [x] Email verification: signed, single-use, expiring token — _sent by the worker from the outbox (`user.verification_requested`, committed with the account); the link is minted at send time, so no token is stored, and a stale event for an address since verified, closed or changed sends nothing_
- [x] `POST /auth/login` — issues a 15-minute access token and a 30-day refresh token, both in httpOnly, Secure, SameSite=Lax cookies
- [x] `POST /auth/refresh` — **rotating** refresh tokens with reuse detection; a reused token revokes the entire family
- [x] `POST /auth/logout` — revokes the refresh token server-side, not just client-side
- [x] Password reset: request → emailed single-use token → set new password → revoke all sessions
- [x] CSRF protection — double-submit cookie pattern, required because auth is cookie-based
- [x] Rate limiting on all auth endpoints, per IP **and** per account, with exponential backoff
- [x] Account lockout after N failed attempts, with a notification email
- [x] RBAC: roles (`customer`, `fulfilment`, `staff`, `admin`, `owner`) and a permission dependency for route protection
- [x] `get_current_user` / `get_current_admin` FastAPI dependencies
- [x] Address book CRUD with a default shipping and billing address
- [x] Storefront auth UI: login, register, forgot password, reset password, verify email — _driven end to end in a browser at 1280 and 375 px_
- [x] Session management page: list active sessions with device and location, allow individual revocation — _device from the user agent; "location" is the IP address — a city lookup needs a GeoIP database, not yet chosen_
- [ ] Optional — OAuth via Google and Apple

**Definition of Done — Phase 5:** Full signup → verify → login → refresh → logout → reset cycle works. Refresh-token reuse is detected and kills the family. Auth endpoints are rate limited. Every branch of this flow has an integration test, including the failure branches.

---

# Phase 6 — Catalog & Search

_Milestone M2._

### 6.1 Catalog domain

- [x] Product and variant models with the option/value matrix (Size × Colour → SKU) — _one variant per option combination, enforced; unused option values pruned_
- [x] Category tree (nested set or `ltree`) and flat collections; a product may belong to many collections — _`ltree`; a move or rename rewrites the whole subtree's paths in one statement_
- [x] Media: S3/R2 presigned upload, automatic WebP/AVIF derivatives at responsive widths, blurhash placeholders — _presigned POST (the bucket enforces type and size); worker writes AVIF+WebP at 320–1920 px, a blurhash, and `product_media.renditions`. Local S3 is SeaweedFS: MinIO no longer publishes public images_
- [x] Public catalog endpoints: list products with cursor pagination, filtering, and sorting; product detail by slug — _keyset cursors tagged with their sort; exact stock shown only at or below 20_
- [x] Admin catalog endpoints: full CRUD for products, variants, options, categories, collections, media — _every mutation audited with actor and field diff; permission-based (`catalog:write`, `inventory:write`)_
- [x] Bulk CSV import/export with row-level validation and a dry-run mode — _all or nothing; dry run is the default; the export is the import format_
- [x] Product reviews: submit, moderate, aggregate rating, verified-purchase badge — _moderated before publication; rating recomputed on each decision; verified badge from a paid order_
- [x] Redis caching for product and collection reads, with event-driven invalidation on write — _per-slug product entries plus a catalog-wide version for listings; invalidated by the outbox relay and directly after admin commits; fails open_

### 6.2 Inventory

- [x] Inventory item per variant: `quantity_on_hand`, `quantity_reserved`, `reorder_point`
- [x] Available-to-sell is a derived value: `on_hand - reserved`. Never stored, always computed.
- [x] Inventory movements as an append-only ledger — every change has a reason and an actor — _the ledger sums to stock on hand, asserted in tests_
- [x] Low-stock threshold alerting — _one email per crossing of the reorder point, not per adjustment_
- [x] Back-in-stock subscription and notification — _new table (migration `0010`); one email per subscriber, never for a variant that sold out again before the job ran_

### 6.3 Search

- [x] Meilisearch index configuration: searchable attributes, filterable facets, sortable fields, ranking rules, synonyms, stop words — _see `INDEX_SETTINGS` in `velo/domains/catalog/search.py`_
- [x] Indexing pipeline driven by the outbox — catalog writes enqueue an index job, never block on the search engine — _ARQ worker (ADR-009); events are published only once Meilisearch has applied them_
- [x] Search endpoint: query + facet filters + sort + pagination, with facet counts returned
- [x] Autocomplete and search-suggestion endpoint
- [x] Full reindex command, safe to run against production — _`pnpm search:reindex`: builds beside the live index, swaps atomically, re-syncs writes made during the build. `pnpm search:check` reports drift; an hourly job repairs it_
- [x] Graceful degradation: if Meilisearch is unreachable, fall back to Postgres full-text search rather than returning an error — _with a 15 s circuit breaker; responses carry `degraded: true`_

**Definition of Done — Phase 6 (M2):** 1,000 seeded products are browsable, filterable, and searchable end to end. Search returns in under 50 ms at p95. Killing the Meilisearch container degrades search instead of breaking the site.

---

# Phase 7 — Cart & Pricing Engine

_The pricing engine is the highest-risk pure logic in the system. It is also the easiest to test exhaustively — so test it exhaustively._

- [x] Cart model supporting both a guest cart (cookie-bound opaque token) and a user cart — _the cookie holds a random token; only its SHA-256 is stored_
- [x] `POST /cart/items`, `PATCH /cart/items/{id}`, `DELETE /cart/items/{id}`, `GET /cart` — _plus `DELETE /cart`, `POST/DELETE /cart/discount`, `POST /cart/merge`; every response is the whole cart, re-priced_
- [x] **Cart merge on login** — combine guest and user carts, summing quantities, respecting stock limits, resolving conflicts deterministically — _at sign-in and at registration; the account's code wins over the guest's; capped at stock and 999 with a `quantity_reduced` warning_
- [x] **Server-side re-pricing on every mutation.** The client sends a variant ID and a quantity. Nothing else. Never a price. — _request models forbid extra fields, so a `price` is a 422; tested_
- [x] Line-item pricing: unit price, compare-at price, quantity, line subtotal
- [x] Discount engine:
  - [x] Code-based discounts and automatic discounts
  - [x] Types: percentage off, fixed amount off, free shipping, buy-X-get-Y — _buy-X-get-Y parameters added in migration `0011`_
  - [x] Eligibility rules: minimum subtotal, specific products/collections, first-order-only, customer segment — _segments (`returning`, `subscribers`, `staff`) added in `0011`; first-order-only is provisional for guests until checkout knows the email_
  - [x] Usage limits: total redemptions, per-customer redemptions, date window
  - [x] Stacking rules — define precisely which discounts combine and in what order they apply — _[docs/PRICING.md](docs/PRICING.md) §3_
- [x] Tax calculation service with a pluggable provider interface; a rules-based default implementation — _`TaxProvider`; `RulesTaxProvider` matches country, region and postal prefix, highest priority wins; inclusive (VAT) and exclusive rates_
- [x] Shipping rate calculation: by zone, weight band, price band, free-over-threshold — _bands measured after product discounts and on shipped weight only_
- [x] Deterministic total assembly with an explicit, documented rounding rule applied at a single point — _half up, once per discount and per tax rate, in `round_minor`; largest-remainder allocation; PRICING.md §7_
- [x] Cart validation on read: flag removed products, price changes, and stock shortfalls rather than silently mutating the cart — _warnings, never silent changes; an unavailable line stays but is not charged_
- [x] Cart expiry and abandoned-cart marking — _worker sweep every 15 min: idle 24 h → abandoned (reactivated on the next change); expired guest carts deleted_
- [x] **Property-based tests** (Hypothesis) on the pricing engine: totals are never negative, discounts never exceed subtotal, the sum of line totals plus tax plus shipping minus discount always equals the order total, and rounding never loses or invents a cent — _seven properties over 400+ generated carts each; engine at 100% branch coverage_

**Definition of Done — Phase 7:** The pricing engine has 95%+ branch coverage plus property-based tests. Every discount type and stacking combination has a test. A client cannot influence any price.

---

# Phase 8 — Checkout & Payments

_Milestone M3 — the critical phase. Read `docs/PAYMENTS-AND-CHECKOUT.md` in full before starting. Nothing here is a place to move fast._

> **Status (2026-09-29): 34/34 — built end to end; M3 waits only on Stripe test keys.** The storefront now has the cart page, the four-step checkout and the Payment Element (below). Earlier status, for the API: Every API-side task is done and tested against real Postgres and Redis, with the production Stripe adapter talking to a fake Stripe over `httpx.MockTransport`: the checkout integration tests, the concurrency suite at N = 2, 10 and 100, and unit tests for the state machine (all 64 transition pairs), both provider adapters, and PCI scope. **Open:** the storefront's Stripe Payment Element (the storefront has no cart or checkout pages until Phase 10), and the DoD's "a test card completes a full purchase", which needs that page and real Stripe test keys (`VELO_STRIPE_*` are empty in `.env`).

### 8.1 Checkout session

- [x] `checkout_sessions` state machine: `initiated → address_set → shipping_set → payment_pending → confirmed` / `failed` / `expired` / `abandoned` — _`domains/checkout/state.py`; three edges added so that a payment arriving late still becomes an order (PAYMENTS-AND-CHECKOUT.md §2)_
- [x] Every transition validated server-side; illegal transitions rejected, not tolerated — _409 `checkout-state`; all 64 pairs tested_
- [x] `POST /checkout` — create a session from a cart, snapshotting the priced cart into the session — _`checkout_sessions.snapshot` (migration `0012`); ownership by an HMAC-derived httpOnly cookie or the signed-in owner; anyone else gets 404_
- [x] `PATCH /checkout/{id}/address` — set shipping and billing addresses, with validation and normalisation — _unshippable → 422 `address-unserviceable`_
- [x] `PATCH /checkout/{id}/shipping` — select a shipping method from the calculated available rates — _plus `GET /shipping-rates` and `POST /abandon`_
- [x] Session TTL (30 minutes) with automatic expiry and reservation release — _worker sweep every minute, and on touch; 410 `checkout-expired`_

### 8.2 Inventory reservation — the oversell guard

- [x] Reserve stock inside the checkout-creation transaction, using `SELECT ... FOR UPDATE` on the inventory row — _rows locked in variant order, so checkouts sharing SKUs cannot deadlock_
- [x] Reservations carry a TTL tied to the checkout session — _extended when payment starts, so 3-D Secure has time_
- [x] Background sweeper releases expired reservations and returns the stock — _checkouts waiting on a payment are left to reconciliation_
- [x] Reservation converts to a permanent inventory movement on payment confirmation — _a `sale` movement in the order's transaction; a payment that outlived its reservation takes free stock and flags any shortfall, never refuses_
- [x] **Dedicated concurrency test suite**: N simultaneous checkouts against 1 unit of stock must produce exactly 1 order and N-1 clean "out of stock" responses. Run it at N = 2, 10, and 100. — _`test_checkout_concurrency.py`; N=100 in 10 s. Also: 8 payments racing for a single-use code, exactly 1 gets it_

### 8.3 Payment abstraction

- [x] Define the `PaymentProvider` protocol: `create_intent`, `capture`, `refund`, `verify_webhook`, `get_status` — _as `get_intent`, plus `cancel` and `parse_event`; statuses, money and events normalised_
- [x] Implement the Stripe adapter — _REST over httpx, pinned API version, idempotency keys, 5-minute signature tolerance. Tested against a fake Stripe, not yet against Stripe itself_
- [x] Implement the Paystack/Flutterwave adapter against the same protocol — _Paystack, unit-tested against fake HTTP. Flutterwave not implemented_
- [x] Provider selection by currency, region, or configuration — _by currency (`VELO_PAYMENT_CURRENCY_PROVIDERS`), else the default; an unconfigured provider → 503_

### 8.4 Payment flow

- [x] `POST /checkout/{id}/payment-intent` — **recompute the total from the database**, then create the provider intent for that amount. The amount sent to the provider is never taken from the request body. — _re-priced under the discount locks; a changed total is 409 `price-changed`, a code that ran out is 422 `discount-expired`, and nothing is charged_
- [x] Idempotency middleware: `Idempotency-Key` header required on all money-moving POSTs; the `idempotency_keys` table stores request fingerprint and response, and replays return the stored response — _a per-route wrapper (`api/idempotency.py`) rather than ASGI middleware; on `POST /checkout` and `/payment-intent` now, refunds in Phase 9_
- [x] Store the payment record in `payment_pending` before calling the provider, so a crash mid-call is recoverable — _`payments.provider_intent_id` is nullable (migration `0012`); the payment id is the provider's idempotency key_
- [x] Frontend integration with Stripe Payment Elements — cards, Apple Pay, Google Pay, Link — _`components/checkout/payment-step.tsx`: the Express Checkout Element first (wallets, Link), then the Payment Element; the Pay button carries the server's amount. Paystack's inline popup for NGN/GHS/ZAR/KES. The cart page, the four-step checkout (contact, delivery, shipping, payment; resumable per tab) and the polling confirmation page came with it, pulling Phase 10.4 forward_
- [x] 3-D Secure / SCA handled entirely inside the provider's element; confirm no card data ever reaches our origin — _`stripe.confirmPayment` runs 3-D Secure in Stripe's frame, and a bank redirect returns to `/checkout/confirmation`, which reads `redirect_status` and polls; there is no card input on our origin. `test_pci_scope.py` fails on any API field that could hold card data_

### 8.5 Webhooks — where orders actually get created

- [x] `POST /webhooks/stripe` — **verify the HMAC signature against the raw request body before parsing anything** — _and `/webhooks/paystack` (HMAC-SHA512)_
- [x] Persist every webhook to `payment_events` keyed by the provider's event ID; a duplicate event ID is acknowledged and dropped
- [x] Return `200` immediately, process asynchronously — providers retry aggressively on slow responses — _the `process_payment_event` job; a retry every minute catches anything the queue lost_
- [x] Handle `payment_intent.succeeded` → convert reservation to a sale, create the order, send confirmation — _confirmation email through the outbox relay_
- [x] Handle `payment_intent.payment_failed` → release the reservation, notify the customer, keep the cart intact — _**deliberately keeps** the reservation until the TTL instead: Stripe retries a declined card on the same intent (PAYMENTS-AND-CHECKOUT.md §2)_
- [x] Handle `charge.refunded`, `charge.dispute.created` — _and `charge.dispute.closed`, `payment_intent.canceled`, `.processing`, `.requires_action`_
- [x] Out-of-order event handling: a `succeeded` event arriving after a `failed` event for the same intent must resolve correctly — _both orders tested; the payment row is locked, so two events for one intent serialise_
- [x] Dead-letter queue for webhooks that fail processing, with alerting and a manual replay tool — _five attempts with backoff, then `dead_lettered_at` and an ops alert; `python -m velo.scripts.payment_events`_
- [x] **Reconciliation job** — every 15 minutes, query the provider for intents in a non-terminal state older than 30 minutes and settle them. This is the safety net for lost webhooks. — _also cancels intents nobody finished, and declined intents on ended checkouts_

### 8.6 Order creation

- [x] Create the order **atomically** in the webhook handler: order + line items + inventory movement + payment record, in one transaction — _when the worker processes the webhook (`domains/checkout/settlement.py`), with discount redemptions and the outbox event_
- [x] Snapshot into every line item: product title, variant title, SKU, unit price, tax rate, discount applied. A later catalog edit must never alter a historical order. — _tested by editing the catalog after purchase_
- [x] Generate a human-readable order number (not the UUID, not a sequential integer that leaks volume) — _`VLO-` and 6 characters from a 30-letter alphabet with no look-alikes_
- [x] Emit the `order.created` event via the outbox for email and analytics
- [x] Clear the cart only after the order is committed — _in the same transaction, so both happen or neither; lines added since checkout began stay_

**Definition of Done — Phase 8 (M3):** A test card completes a full purchase end to end. The concurrency suite passes at N=100. Replaying a webhook creates no second order. Killing the API between intent creation and webhook delivery still results in a correct order once reconciliation runs. **Every one of these is tested, not assumed.**

> **Against the DoD:** concurrency at N=100 ✅. Webhook replay → one order ✅. Paid with no webhook delivered → reconciliation creates the order ✅, and a crash between writing the payment and storing its intent is recovered ✅. The storefront payment page ✅. **A real test card end to end: not yet run** — `VELO_STRIPE_SECRET_KEY`, `VELO_STRIPE_PUBLISHABLE_KEY` and `VELO_STRIPE_WEBHOOK_SECRET` are empty in `.env`. With test keys set and `stripe listen --forward-to localhost:8000/api/v1/webhooks/stripe` running, pay with `4242 4242 4242 4242` (and `4000 0027 6000 3184` for 3-D Secure).

---

# Phase 9 — Orders, Fulfilment & Returns

> **Status (2026-09-29): 13/13 — done.** Built in `domains/orders/` (state, lifecycle, fulfilment, refunds, returns, documents, queries) and served by `api/v1/orders.py`, `api/v1/admin_orders.py` and `POST /webhooks/tracking`; migration `0013`. `tests/integration/test_orders.py` runs the DoD against real Postgres and Redis with the production Stripe adapter talking to the fake Stripe; `tests/unit/test_order_rules.py` covers both state machines and the refund arithmetic, with a Hypothesis property that any split of a line refunds exactly its total.

- [x] Order status machine: `pending → paid → processing → partially_fulfilled → fulfilled → delivered`, plus `cancelled` and `refunded` — _`domains/orders/state.py`, with `payment_status` and `fulfilment_status` kept separately (the money and the goods move independently of the order's life); anything else is 409 `order-state`_
- [x] `order_events` as an immutable audit trail — every status change records actor, timestamp, and reason — _insert-only, written in the same transaction as every change; staff mutations also go to `audit_log`. The DoD test asserts the whole trail in order_
- [x] Customer order endpoints: list, detail, track, cancel (only while cancellable) — _plus guest access by a signed link (an HMAC of the order id; nothing stored) and `POST /orders/lookup` by number and email, 10 an hour per IP_
- [x] Admin order endpoints: list with filters, detail, transition status, add internal notes
- [x] Fulfilment: create a fulfilment against selected line items, attach carrier and tracking number, support partial fulfilment — _tracking links built for UPS, USPS, FedEx, DHL, Royal Mail, DPD and GIG; nothing ships while a chargeback is open_
- [x] Shipment tracking integration (carrier API or webhook), with customer-facing status — _`POST /webhooks/tracking`, HMAC-SHA256 signed; the order is delivered when every parcel is_
- [x] Cancellation: allowed pre-fulfilment; restores inventory, triggers a full refund — _restores exactly what the ledger says the order took, which can be less than it bought_
- [x] Refunds:
  - [x] Full and partial, at line-item granularity — _`refund_items`; units priced as their cumulative share of the line, so parts always sum to the line total; shipping and goodwill on top_
  - [x] Validated against the captured amount — cumulative refunds can never exceed it — _pending refunds count too, under the payment row's lock; four simultaneous refunds, one succeeds_
  - [x] Idempotent, via the same key mechanism as payments — _and the refund's own id is the provider's idempotency key; unsubmitted refunds are resubmitted every 5 minutes (Paystack's, which cannot be deduplicated, are escalated instead)_
  - [x] Recorded in the refund ledger with a reason code
- [x] Returns / RMA: customer request → admin approval → return label → receipt at warehouse → refund
- [x] Restocking decision on return receipt (restock vs write off as damaged)
- [x] Invoice PDF generation and email delivery — _`fpdf2`, from the order's snapshots; attached to the confirmation email and downloadable by customer and admin_
- [x] Packing slip generation for fulfilment staff — _per order, or per parcel_
- [x] Order search by number, customer email, or SKU

**Definition of Done — Phase 9:** An operator can take an order from paid to delivered, process a partial return, and issue a partial refund — entirely through the API, never touching the database. Every transition is in the audit trail.

> **Against the DoD:** ✅ `test_an_operator_takes_an_order_from_paid_to_delivered`, `test_a_partial_return_and_its_partial_refund`, `test_a_partial_refund_at_line_level_is_idempotent` — all through the API, with the audit trail asserted.

---

# Phase 10 — Storefront UI

_Milestone M4 begins. This is where the design from Phase 2 becomes real._

### 10.1 Shell

- [x] Root layout: header with search and cart, mega-nav, footer, mobile nav drawer — _`components/site-header.tsx`, `components/shell/`; Radix NavigationMenu for the mega-nav, a left drawer on phones, the cart drawer on the right_
- [x] Theme toggle with no flash of incorrect theme on first paint — _from Phase 3: `ThemeScript` sets the theme before first paint; three states, not two_
- [x] Global loading, error, and 404 boundaries — _`app/loading.tsx` (shaped skeletons), `error.tsx` (retry, the digest for support), `global-error.tsx`, `not-found.tsx`_
- [x] Toast system for feedback on every mutation — _`notify` (Phase 5), now used by cart, wishlist, returns, cancellation — never for payment outcomes, which are page states_
- [x] Skip-to-content link and a visible, high-contrast focus ring throughout — _skip link lands on a focusable `<main>`; every control keeps the 3 px ring_

### 10.2 Discovery

- [x] Home page: hero, featured collections, new arrivals, editorial blocks — server-rendered — _revalidated every minute; each section drops out rather than erroring when the catalog cannot be read_
- [x] Collection and category listing: filter sidebar (desktop) / filter sheet (mobile), sort control, responsive grid — _one `Listing` for all products, categories and collections; brand options from the search facets_
- [x] Filters reflected in the URL so results are shareable and back/forward behave correctly — _`lib/listing.ts`: prices in whole units in the URL, minor units to the API_
- [x] Infinite scroll or "load more" with a working, accessible fallback — _"Load more" is a real link to the next cursor; with JavaScript it appends, announces the count, and focuses the first new product_
- [x] Search overlay with debounced instant results, keyboard navigation, and recent searches — _a combobox: 200 ms debounce, arrows and Enter, `/` opens it from anywhere; full results at `/search` with facet links_
- [x] Product card: image with hover state, title, price with compare-at, rating, quick-add, wishlist toggle — _quick-add adds directly only when there is one variant; otherwise it opens the product rather than guess a size_

### 10.3 Product detail

- [x] Image gallery: thumbnails, zoom, swipeable on mobile, lazy-loaded below the fold — _scroll-snap strip with dots on phones, thumbnails on desktop, a full-size dialog; follows the chosen variant's image_
- [x] Variant selector reflecting real availability — unavailable combinations are visibly disabled, not silently broken — _struck through, `aria-disabled`, labelled "— out of stock"; colour swatches carry their name_
- [x] Live stock indicator ("Only 3 left")
- [x] Add to cart with optimistic UI and rollback on failure — _confirms at once and opens the drawer; a refusal rolls back with the reason. Sticky add-to-cart bar on phones; back-in-stock sign-up when sold out_
- [x] Description, specifications, shipping and returns info in accessible accordions — _native `details`/`summary`_
- [x] Reviews with distribution summary, pagination, and a submission form — _new `GET /products/{slug}/reviews/summary` for the bars_
- [x] Related and recently viewed products — _recently viewed kept in this browser only_
- [x] Full structured data (`Product`, `Offer`, `AggregateRating`) for rich search results — _`AggregateOffer` across variants; `<` escaped in the JSON-LD_

### 10.4 Cart & checkout

- [x] Cart drawer (quick view) and a full cart page
- [x] Quantity stepper with optimistic update, stock cap, and debounced server sync — _300 ms debounce, capped at `max_quantity`, the server's value restored on refusal_
- [x] Discount code entry with clear success and failure messaging
- [x] Order summary that updates live and shows exactly how the total was reached — _"Calculated at checkout", never $0.00, until there is an address_
- [x] Checkout: a four-step flow with a persistent progress indicator, resumable if the customer navigates away — _the session id is kept per tab; the step shown is derived from the server's state_
- [x] Address form with autocomplete, per-country field layouts, and inline validation — _`autocomplete` tokens sectioned for shipping and billing, per-country labels and postcode formats, saved addresses as cards. No address-lookup service is wired in — browser autofill does the work_
- [x] Shipping method selection with prices and delivery estimates — _with Phase 8_
- [x] Payment step with Stripe Payment Elements, express wallet buttons surfaced first — _with Phase 8_
- [x] Review step showing the final, authoritative total before the customer commits — _on the payment step, with the server's amount — the same as on the Pay button_
- [x] Order confirmation page with full order detail and next steps — _with Phase 8: polls on the PAGE-SPECS §1.4 schedule and never asks for a second payment_
- [x] **Checkout error handling** — card declined, network failure, session expired, stock lost during checkout. Every one has a designed, recoverable state. Never a blank screen, never a raw error. — _declined (Stripe's message, retry on the same intent), network (plain-words alert, the idempotency key kept for the retry), expired (restart, cart kept), stock lost (the short lines named, back to the cart), price changed (re-priced summary, pay again), payments down (items still held). Exercised against the API; the browser pass is in the DoD note below_

### 10.5 Account

- [x] Order history and order detail with tracking — _per-parcel tracking, a timeline, invoice PDF, cancel, "Buy again"; guests by signed link or `/orders/lookup`_
- [x] Address book management — _Phase 5_
- [x] Profile and password settings — _Phase 5_
- [x] Wishlist — _`wishlist_items` (migration `0014`), `/account/wishlist`; hearts on every card_
- [x] Return request flow — _lines, quantities and a reason from the order page; the RMA, the label to print, and the refund timeframe; `/account/returns` follows them all_

**Definition of Done — Phase 10:** Every page works at 320px and at 2560px, in both themes, with a keyboard alone, and with a screen reader. Every error path from 10.4 has been manually exercised.

> **Against the DoD (2026-09-29):** every page is built, type-checked, linted and in the production build; each server-renders `200` against the dev API with the seeded catalog, an unknown path is `404`, and the checkout's calls were walked end to end over HTTP down to the designed "payments unavailable" state. **Not yet done: the manual pass** — 320 px and 2560 px, both themes, keyboard alone, and a screen reader, in a real browser. That is a person's job with the page in front of them, and it is what stands between 35/35 tasks and this phase being closed.

---

# Phase 11 — Admin Dashboard

- [x] Admin shell: sidebar navigation, breadcrumbs, command palette (⌘K), role-aware menu — _the menu is built from `GET /admin/me`'s permissions; ⌘K jumps to pages and finds orders and customers_
- [x] Dashboard: revenue chart, order count, AOV, conversion funnel, low-stock alerts, recent orders — _needs-attention first; money tiles only for `reports:read`; charts are dependency-free SVG_
- [x] Product list: server-side pagination, search, filters, bulk actions — _status filter and search; bulk publish/unpublish/archive/delete with a per-item failure report_
- [x] Product editor: details, variant matrix builder, media manager with drag-to-reorder, SEO fields, publish/unpublish — _reorder by drag or by keyboard; uploads go straight to storage through presigned POSTs_
- [x] Inventory view: stock levels across variants, inline adjustment with mandatory reason, movement history
- [x] Bulk CSV import with column mapping, validation preview, and dry-run before commit
- [x] Order list: filter by status, date range, and value; saved views — _`min_total`/`max_total`, `needs_attention` and oldest-first sort added to the API; saved views per staff member (`saved_views`, migration `0015`)_
- [x] Order detail: full timeline, customer info, line items, payment and refund history, fulfilment actions, internal notes
- [x] Fulfilment workflow: select items, enter carrier and tracking, print packing slip
- [x] Refund modal: per-line-item selection, reason code, live preview of the refund amount, confirmation step — _the preview uses the server's own cumulative line-share arithmetic, unit-tested in the admin_
- [x] Return/RMA queue with approve and reject actions — _and receive with a restock decision, refund, close_
- [x] Customer list and profile: order history, lifetime value, addresses, notes — _`/admin/customers`; lifetime value is paid less refunded; notes in `customer_notes`_
- [x] Discount builder with live rule preview and an eligibility tester — _`POST /admin/discounts/preview` prices a sample basket through checkout's own pricing engine; terms lock once redeemed_
- [x] Analytics: revenue over time, top products, conversion funnel, cohort retention, CSV export — _`/admin/analytics/*`, computed live in one aggregate each; UTC days_
- [x] Settings: store details, shipping zones and rates, tax rates, email templates, payment providers — _email *texts* (intro lines, signature) are editable, the templates themselves are code (ADR-011); providers are shown, never their keys_
- [x] Staff management: invite, assign role, revoke access — _emailed single-use invitations (`staff_invitations`); revoking ends every session; the last owner cannot be removed_
- [x] Audit log viewer with filtering by actor, entity, and date
- [x] Optimistic updates with rollback throughout; no full-page reloads on mutation — _money-moving actions are confirmed and never optimistic_

**Definition of Done — Phase 11 (M4):** An operator with no SQL access can run the entire store: add products, manage stock, fulfil orders, issue refunds, create discounts, and read performance.

> **Against the DoD (2026-10-02):** every operation has a screen and an API, permission-checked on both sides; the API half is tested (`test_admin.py`, `test_orders.py`, and the catalog and inventory suites). The admin app type-checks, lints and builds (25 routes). **Not yet done:** an operator walking the whole store in a browser — the pages were built and checked statically, not clicked through. That walk-through closes M4.

---

# Phase 12 — Notifications & Background Jobs

- [x] ARQ worker setup with queue definitions, retry policy, and exponential backoff — _`retrying` (platform/job_failures.py): 5 s doubling to a 10-minute cap, six tries_
- [x] Outbox pattern: domain events written in the same transaction as the state change, relayed by a poller. No lost events, no dual-write inconsistency. — _since Phase 6; Phase 12 added exactly-once email on top_
- [x] Email templates in React Email: order confirmation, shipping notification, delivery confirmation, refund issued, password reset, email verification, welcome, back-in-stock, abandoned cart — _**Jinja2, not React Email** — ADR-011: the Python worker renders what it sends. Thirteen kinds, each HTML (600 px tables, inline styles) with a plain-text twin, every one rendered by the unit suite_
- [x] Resend integration with delivery-status webhook handling — _`ResendTransport` when `VELO_RESEND_API_KEY` is set, SMTP otherwise; `/webhooks/resend` verifies Svix signatures and records delivered, bounced and complained — a complaint or bounce stops marketing to that address_
- [x] Abandoned-cart recovery: scheduled sequence at 1 hour, 24 hours, and 72 hours, with a single-click unsubscribe — _new activity restarts the sequence; `List-Unsubscribe-Post` one-click and a page; a guest's reminder link restores the cart in whatever browser opens it_
- [x] Scheduled jobs: reservation sweeper, payment reconciliation, search reindex, low-stock check, nightly analytics rollup — _the rollup is a nightly digest to ops (yesterday's sales, refunds, low stock): analytics are computed live, so a summary table would only be one more thing to keep in step_
- [x] Job failure alerting and a dead-letter queue with a replay tool — _`job_failures` + `job.dead_lettered` alert + `python -m velo.scripts.jobs --replay`_
- [x] Email preview route in development so templates can be reviewed without sending — _`/api/v1/dev/emails`, mounted only in development_
- [x] Per-customer notification preferences, honoured by every sender — _`/account/preferences` and `email_preferences` by address (guests too); transactional email is always sent — receipts are not optional_
- [x] Rate limiting on outbound email per recipient — _30 transactional an hour, 2 marketing a day; over the limit is logged and skipped_
- [ ] All transactional emails render correctly in Gmail, Outlook, and Apple Mail, and have a readable plain-text alternative — _plain-text alternative ✅ for every email; the client rendering is designed for (tables, inline styles, no web fonts) but **not verified**: that needs Litmus or Email on Acid_
- [x] Worker health check and queue-depth metric exported to monitoring — _`GET /system/worker` (heartbeat, ARQ queue depth, outbox, dead jobs and events, failed email) and `?format=prometheus`_

**Definition of Done — Phase 12:** Every customer-facing event sends the right email exactly once. Jobs retry on failure and alert when they exhaust retries. No event is lost if the worker is down.

> **Against the DoD:** ✅ `test_notifications.py` — an event relayed twice emails once; a provider failure is retried and still sends once; a job that keeps failing is dead-lettered and alerted; the outbox holds events until the relay runs.

---

# Phase 13 — Testing & QA

_Much of this is written alongside earlier phases. This phase is where coverage is closed out and the gates are enforced._

- [x] pytest configured with async support, testcontainers Postgres, and per-test transaction rollback — _pytest-asyncio against the Docker Compose Postgres rather than testcontainers — the same containers locally and in CI. Isolation is a truncate after each test, not a rolled-back transaction: the suites commit for real, race real transactions and run the worker, which a wrapping transaction would hide_
- [x] Factory fixtures for every domain entity — _helper factories rather than a library: `catalog_support` (products, variants, collections), `checkout_support` (checkouts, a fake Stripe, signed events), `test_cart` (discounts, shipping, tax), `sign_in_as` (users by role); the rest are made through the API_
- [x] Unit tests: pricing engine, discount rules, tax, shipping, all state machines
- [x] Property-based tests on money arithmetic and total assembly — _Hypothesis: pricing (Phase 7) and refund line shares_
- [x] Integration tests covering every API endpoint, including auth failures and validation errors — _per-domain suites, and the contract tests send generated valid and invalid requests to every operation_
- [x] **Concurrency test suite**: simultaneous checkouts, simultaneous cart mutations, simultaneous discount redemptions against a usage limit — _`test_checkout_concurrency.py` (2–100 shoppers for one unit), `test_cart_concurrency.py` (one cart from many tabs; limits of 3 and 5 raced by 10 and 25)_
- [x] **Webhook test suite**: duplicates, out-of-order delivery, invalid signatures, malformed payloads, replay attacks — _`test_webhooks.py` with `test_checkout.py`; found that a signed but malformed event was a 500 — Stripe and Paystack now refuse it_
- [x] Contract tests via schemathesis against the OpenAPI schema — _`test_contract.py`: every operation, no 5xx, statuses, content types and bodies as documented. The document now describes errors as RFC 9457 problems and CSV/PDF/Prometheus responses as such; found that a NUL character in any text field was a 500 (now 422)_
- [x] Vitest + Testing Library for components, hooks, and form validation — _≈1,270 tests across storefront and admin_
- [x] MSW for frontend API mocking — _handlers typed against the generated OpenAPI paths_
- [x] Playwright E2E on Chromium, Firefox, and WebKit: — _`e2e/`, `pnpm e2e`: its own database, ports and search index; payments through the sandbox provider; 18/18. Open question: in WebKit, client-side navigation after a completed prefetch sometimes never finishes — prefetch is refused there in the suite; check on real Safari_
  - [x] Guest purchase, full journey
  - [x] Registered purchase with a saved address
  - [x] Discount code applied at checkout
  - [x] Card declined, then retried successfully
  - [x] Out-of-stock encountered during checkout
  - [x] Return and refund, end to end
- [x] axe-core accessibility assertions on every page in the Playwright suite — _zero violations; fixing them meant darker status colours (WCAG 1.4.3) in light mode_
- [ ] k6 load test: 500 concurrent checkouts, asserting p95 latency and zero oversells — _built (`loadtest/checkout.js`, manual workflow `load.yml`, sandbox payments). On this laptop: **zero oversells** (200 of 200 units sold, 200 paid, stock never negative) but **p95 thresholds missed** — 500 shoppers on one SKU queue on its inventory row lock (checkout start p95 ≈ 24 s) and exhaust the connection pool. Re-run on CI hardware, and look at how long checkout holds that lock in Phase 14_
- [x] Coverage gates enforced in CI: 85% backend, 75% frontend — the build fails below them — _backend 89% (unit and integration together); storefront 99.8%, admin 99.9%_
- [ ] Manual QA pass on real devices: iOS Safari, Android Chrome, desktop Safari

**Definition of Done — Phase 13:** CI runs the full suite on every PR and blocks merge on failure. All six E2E journeys pass on all three browsers. Zero axe violations.

> **Against the DoD (2026-10-02):** the six journeys pass on all three browsers with zero axe violations (18/18). CI now runs lint, types, the whole API suite behind the coverage gate, the contract tests, both frontends behind theirs, and the E2E suite, on the same containers as local development. **Not yet seen:** that workflow green on GitHub (as in Phase 3), and branch protection requiring it.

---

# Phase 14 — Performance & SEO

- [ ] Establish the performance budget in CI (Lighthouse CI) and fail the build when it regresses — _built: `lighthouserc.json` (DISCOVERY.md §6.3 thresholds on the throttled mobile profile) and a `lighthouse` job in `ci.yml` against a seeded production build of home, a category and a product. **Not yet run**: this machine's Chromium lacks system libraries (`sudo npx playwright install-deps chromium`); the first green CI run ticks it_
- [x] Database: review `EXPLAIN ANALYZE` for every hot query; eliminate all N+1 queries with eager loading — _`docs/PERFORMANCE.md`: nine N+1s fixed (admin returns 102 → 4 queries, order lists 52 → 3, relay 100 → 1), listing 39 → 1.6 ms, migration 0018; `test_query_counts.py` guards it. Broad price/rating sorts stay ~45 ms until price is denormalised_
- [x] Redis caching for catalog reads with event-driven invalidation — _`CatalogCache` since Phase 6, invalidated by the outbox relay on product, inventory and media events_
- [ ] Next.js caching strategy per route: static, ISR, or dynamic — decided deliberately, not by default — _found: the root layout reads the session cookie (wishlist, header), which makes **every** route dynamic; catalog fetches are still data-cached (60–300 s), but page-level ISR is not in effect. Fix: move the session-dependent shell to the client so catalog pages can be ISR_
- [x] Image optimisation: AVIF/WebP, responsive `srcset`, lazy loading below the fold, blurhash placeholders, explicit dimensions to prevent CLS — _`CatalogImage`: `<picture>` over the API's AVIF/WebP renditions, intrinsic size, eager + `fetchpriority=high` only above the fold, blurhash decoded server-side to an inline SVG. Previously the storefront served unoptimised originals_
- [x] Bundle analysis; code-split heavy routes; defer non-critical third-party scripts — _the `radix-ui` barrel shipped every primitive to any page rendering a Button: `optimizePackageImports` took home 214 → 135 kB first-load JS; every storefront route is now under the 180 kB budget. Payment scripts already load only on the payment step_
- [x] Font loading with `font-display: swap` and preloaded subsets — _`next/font` since Phase 3: self-hosted, Latin subset, preloaded, swap_
- [x] Preconnect to the CDN and payment provider origins — _API and media CDN (`NEXT_PUBLIC_MEDIA_ORIGIN`) site-wide; Stripe and Paystack on `/checkout` only_
- [x] API response compression and `ETag`/conditional-request support — _GZip over 1 KB; weak body-hash ETags and 304s on public catalog and search GETs only (`velo/api/conditional.py`); Cache-Control on every catalog GET; the CSRF cookie is no longer set on publicly cacheable responses_
- [x] SEO: per-page metadata, Open Graph, Twitter cards, canonical URLs — _`metadataBase` from `NEXT_PUBLIC_SITE_URL`; canonicals drop filter/sort params; `NEXT_PUBLIC_SITE_NOINDEX=1` for staging_
- [x] `sitemap.xml` generated from the live catalog, and `robots.txt`
- [x] JSON-LD structured data: `Product`, `Offer`, `AggregateRating`, `BreadcrumbList`, `Organization` — _plus `WebSite` with a `SearchAction`_
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

| Date       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | By     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 2026-09-20 | Initial plan created. 19 phases.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Claude |
| 2026-09-24 | **Phase 0 closed** (13/14; the per-phase register review is standing). `docs/DISCOVERY.md` written; the inline risk register moved there and expanded from 7 to 15 risks with exposure ratings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Claude |
| 2026-09-24 | **Phase 1 closed** (12/12). `docs/adr/` created with an index, a template, and ADR-001 … ADR-010 in full. `docs/ARCHITECTURE.md` §10 now resolves to real files.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Claude |
| 2026-09-24 | **Phase 2 at 9/17.** Tokens, contrast, type, breakpoints, motion, state doctrine, checkout friction, and the accessibility pass are specified in `docs/DESIGN-SYSTEM.md`. Outstanding: the remaining primitives and commerce components, account and admin pages, and the clickable checkout prototype.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Claude |
| 2026-09-24 | Progress table recounted against the actual checkboxes: **326 tasks, not 301.** Ten phases were miscounted, Phases 8 and 10 most heavily. Estimates unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Claude |
| 2026-09-24 | **Phase 3 written end to end**, and **not executed**: monorepo layout, legacy files archived to `legacy/`, shared config package with the design tokens, FastAPI skeleton (app factory, typed settings, JSON logging with correlation IDs, RFC-9457 errors, `/health` and `/ready`, a walking-skeleton route reading Postgres through a service and repository), unit tests, both Next.js apps, the typed API client, dev containers, production Dockerfiles, pre-commit hooks, and CI. Verification is blocked by a full disk.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Claude |
| 2026-09-24 | **Phase 2 to 16/17.** Remaining primitives and commerce components specified in `docs/DESIGN-SYSTEM.md` §4, with a per-component state matrix. `docs/PAGE-SPECS.md` written: storefront, account, and admin pages with a mobile coverage checklist. Only the clickable checkout prototype remains.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Claude |
| 2026-09-25 | **Phase 3 to 17/24 — API skeleton verified.** Disk freed enough for `uv sync`. First execution found and fixed: a startup crash on comma-separated `VELO_CORS_ORIGINS` (pydantic-settings JSON-decodes env lists — now `NoDecode`, with a regression test), a 500-handler test that let the transport re-raise, a deprecated Starlette 422 constant, 6 ruff issues, and 8 stale `type: ignore`s. `pydantic-settings` floor raised to 2.7. Integration tests, containers, and both frontends remain unexecuted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Claude |
| 2026-09-25 | **Phase 3 to 19/24 — web verified.** `pnpm install` ran (the link is now ~1.8 MB/s). First execution of the frontend found and fixed: `eslint` not reachable from the apps under pnpm's strict layout, `prettier-plugin-tailwindcss` referenced but not installed, `@types/node` missing in api-client, no ESLint config in api-client, type-aware lint failing on `.mjs` files, the Next ESLint plugin never loaded (swapped `eslint-config-next` for `@next/eslint-plugin-next`), and a relative `outputFileTracingRoot`. Docker fixes found by reading, not running: no `.dockerignore` (the build would have copied host `node_modules`, `.venv`, and `.env` into images, and overwritten the API image's Linux venv with the Windows one), workspace-package `node_modules` not copied into the web builder, and no standalone output for admin. Standalone output is now opt-in via `NEXT_OUTPUT_STANDALONE=1`. Whole repo run through Prettier; `.prettierignore` added.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Claude |
| 2026-09-26 | **Phase 3 to 20/24 — M1 skeleton runs end to end.** Docker came up; integration tests pass against real Postgres and Redis, and the storefront renders the Postgres version and time through the API. Found and fixed on the way: a host Postgres on 5432 intercepting the container (ports now `VELO_POSTGRES_PORT`/`VELO_REDIS_PORT`, tests take `VELO_TEST_DATABASE_URL`), the root `.env` never read when the API runs from `apps/api` (now reads `../../.env` then `.env`; regression test added, and the missing-settings test isolated from real `.env` files), and `database_time` shipped as a naive timestamp despite DATA-MODEL.md §1 (now `AwareDatetime`, ISO 8601 with offset; asserted in the integration test).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Claude |
| 2026-09-26 | **Phase 3 to 21/24 — fonts loaded.** Inter and JetBrains Mono via `next/font`; both apps build with no warnings, which also confirms the absolute `outputFileTracingRoot` and the Next ESLint plugin fix. Stopped on disk again: C: fell to ~90 MB with nothing of this project running. Cause: `pagefile.sys` is dynamically sized (17.4 GB, grown during builds) and `hiberfil.sys` holds 6.4 GB; the Docker WSL disk is 6.3 GB, ~3.3 GB of it another project's Supabase images. Remaining Phase 3 work (shadcn/ui, image builds, pre-commit) waits on the owner freeing space.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Claude |
| 2026-09-26 | **Phase 3 to 22/24 — shadcn/ui vendored, API image verified.** Seven primitives in the storefront behind a token bridge; Button and Toaster rebuilt to DESIGN-SYSTEM.md §4 with 10 tests. The API image had never been able to start (venv path mismatch) — fixed and smoke-tested. Pre-commit Python hooks now run through uv. The web image build filled C: to 0 MB (Docker's disk grew 6.3 → 10 GB) and was stopped; Docker was left unresponsive and the dev containers could not be stopped cleanly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Claude |
| 2026-09-26 | **Phase 3 to 23/24 — pre-commit verified.** All 15 hooks pass. Hibernation disabled by the owner (+6.4 GB). The web image is still unbuilt: Docker Desktop's engine did not recover from the full disk, and a scripted restart left it stopped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Claude |
| 2026-09-27 | **Phase 3 — web images verified; typed client made real.** Storefront and admin images build and serve; the storefront container renders Postgres data through the API container. Fixed the runtime group (`nogroup` → `nodejs`). Resolving the `schema.d.ts` contradiction found the "typed" client was untyped (`createClient` without `paths`, schema never generated) and the CI stale-client check a no-op. Added `scripts/export_openapi.py`, committed the schema, switched the skeleton page to the client, and corrected `pnpm generate:client` → `generate:api` in README.md and API-SPEC.md. Still 23/24: only the second-machine clean-clone run remains, plus a first CI run once the repository has a remote.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Claude |
| 2026-09-28 | **Phase 4 closed** (15/15). SQLAlchemy models for all 38 tables in DATA-MODEL.md, one per domain package; async Alembic with a constraint naming convention and nine migrations (extensions and `uuidv7()`, then one per domain, ordered by foreign-key dependency); the `Money` value object and a `MinorUnits` column type that refuses floats; Argon2id password hashing (brought forward from Phase 5 for the seed's users); and a deterministic seed. Spec fixes recorded in DATA-MODEL.md: Postgres 16 has no `uuidv7()`, and `idx_discounts_active` used `now()` in an index predicate, which Postgres rejects. Also fixed a pre-existing test that failed whenever the developer's `.env` set `VELO_DEBUG=true`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Claude |
| 2026-09-28 | **Phase 5 to 13/16 — the API meets the Definition of Done.** Register (strength policy, HIBP k-anonymity check), email verification, login, rotating refresh with family-wide revocation on reuse, server-side logout, password reset that revokes every session, double-submit CSRF, per-IP and per-account rate limits, lockout with exponential backoff and a notification email, permission-based RBAC with `get_current_user`/`get_current_admin`, and the address book. 342 tests pass against real Postgres and Redis; register → MailHog → refresh → reuse → family revoked also checked against a running server. Storefront auth and account screens build and lint clean — 11 lint errors fixed (floating promises in handlers, checkbox labels) — but are not yet exercised in a browser. Sessions show the IP address as location; a GeoIP lookup is not built. Integration runs on this machine need `VELO_TEST_DATABASE_URL` on port 5433, because a host Postgres holds 5432.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Claude |
| 2026-09-28 | **Phase 5 closed** (15/16; optional OAuth open). Browser pass on the storefront, driving headless Edge: create account → emailed verification link → profile edit → add address → sessions → sign out → signed-out redirect → wrong password → forgot password → emailed reset link → sign in with the new password, all green, and the lockout cooldown message checked by hitting the per-IP limit for real. Found and fixed: the header overflowed a 375 px viewport by 8 px once signed in (the account link is now icon-only on phones, name kept for screen readers), and no favicon (a 404 on every page; `app/icon.svg` added). A hydration warning on the Radix checkbox appeared once on a cold dev compile; the server HTML matches the client, and it did not recur.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Claude |
| 2026-09-28 | **Phase 6 closed** (19/19, M2). Catalog, inventory and search domains; public, search and admin routers; the ARQ worker (`velo/worker.py`) relaying the outbox; `pnpm worker`, `search:reindex`, `search:check`, `storage:init`; `seed --products N`. Migration `0010`: back-in-stock subscriptions, `product_media.renditions`, and `idx_variant_option_values_value` — a missing reverse index found by `EXPLAIN` (a colour filter scanned the primary key 420 times). DoD measured on 1,000 products / 11,701 variants with API and client in Linux containers: search p50 12 ms, p95 15 ms (Meilisearch 1 ms); p95 41 ms at 4 concurrent per worker — beyond that one worker queues, so capacity is workers, not latency. Meilisearch stopped: p95 62 ms, all `degraded`, no errors. Found and fixed on the way: `httpx` POSTs to Meilisearch stalled ~45 ms behind Docker's relay (searches are now GET), Meilisearch's small replies stalled ~7% of keep-alive searches by ~40 ms on Linux (searches use a fresh connection), `localhost` costs ~45 ms per HTTP call on Docker Desktop for Windows (dev URLs are now `127.0.0.1`), the Postgres fallback took 49 s for a filtered facet count (now resolves ids once: 40–70 ms), the relay published events before Meilisearch applied them, a category move crashed on `subpath` of the node itself, reviews 500'd because the API never loaded the orders mapper, and admin routes read a closure-local dependency FastAPI cannot resolve under postponed annotations. MinIO's images are gone from Docker Hub; SeaweedFS replaces it locally. 100 new tests (441 total), all against real Postgres, Redis, Meilisearch and S3. | Claude |
| 2026-09-29 | **Phase 7 closed.** Pure pricing engine (`velo/domains/cart/pricing.py`): subtotal, product discounts by an explicit stacking policy, shipping bands, exclusive and inclusive tax, one rounding point (half up, per discount and per tax rate) and largest-remainder allocation — rules written up in `docs/PRICING.md`. Discount eligibility by customer and calendar (`discounts/service.py`), rules-based `TaxProvider` and shipping zones (`shipping/service.py`), and the cart service and API: guest carts behind a hashed cookie token, merge at sign-in and registration, warnings instead of silent changes, 60/min cart and 20/h code-guessing limits, and a worker sweep for abandoned and expired carts. Migration `0011`: buy-X-get-Y quantities, customer segments and check constraints on discounts; the applied code on carts; the last-shown price on cart lines (for warnings, never charged). Engine at 100% branch coverage with 46 example tests and 7 Hypothesis properties; 38 cart integration tests; 13 eligibility unit tests. Found and fixed: coverage under-reported every async service by ~40 points because SQLAlchemy's greenlets hid code from the tracer — `concurrency = ["greenlet", "thread"]` in `pyproject.toml`; the whole API measures 91%. Live check on the dev data: automatic 15%-over-$150 applied without a code, CA tax 7.25% on the discounted amount, WELCOME10 accepted but outclassed, an expired code refused with its reason, UK VAT extracted not added.                                                                                                                                                                       | Claude |
| 2026-09-29 | **Phase 8 built (34/34) and Phase 9 closed (13/13).** Storefront: cart page, four-step checkout (resumable per tab), Stripe Express Checkout and Payment Elements, Paystack inline, and the polling confirmation page; a minimal product list and page to buy from (Phase 10 finishes them). API: order, return and shipment state machines; cancellation that restocks exactly what the ledger took; refunds by line, shipping and goodwill, priced from the snapshot, bounded by the capture with pending refunds counted, idempotent, submitted after commit and reconciled every 5 minutes (Paystack escalated, not retried blind); fulfilment with tracking links and a signed carrier webhook; returns with a restock decision at receipt; invoice, packing slip and return label PDFs; order search by number, email or SKU. Found on the way: webhook-recorded refunds would have looked unsubmitted to the retry job and been sent again — now marked submitted. Migration `0013`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Claude |
| 2026-09-29 | **Phase 10 built (35/35); the manual viewport and accessibility pass is what remains.** Shell, discovery (home, listings with URL-held filters and a no-JS "Load more", search overlay and results page), product page (gallery, availability-aware variants, optimistic add to cart, sticky mobile bar, back-in-stock, reviews with distribution, related, recently viewed, JSON-LD), cart drawer, a review step before paying, and the account area (orders with per-parcel tracking and timeline, cancel, returns with labels, wishlist, guest access by signed link or lookup). API additions: the wishlist (migration `0014`) and `GET /products/{slug}/reviews/summary`. All pages server-render against the dev API; the checkout's calls were walked end to end over HTTP.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Claude |
| 2026-10-02 | **Phase 11 built (18/18) and Phase 12 to 11/12.** Admin: a role-aware shell with ⌘K, and every operator screen — dashboard, analytics, products with a variant matrix and media manager, inventory, CSV import with column mapping, orders with saved views, fulfilment, a refund modal with a live preview, returns, customers, the discount builder with an eligibility tester, settings, staff invitations, the audit log (built by four parallel agents on a shared foundation). API: customers, discounts with a pricing-engine preview, shipping and tax, settings, staff, audit, saved views, analytics (migration `0015`). Email (ADR-011: Jinja2, not React Email): thirteen templated kinds with plain-text twins, exactly-once sending through `sent_emails`, Resend with Svix-verified delivery webhooks, preferences and one-click unsubscribe, the abandoned-cart sequence, per-recipient rate limits, a development preview; jobs: backoff, a dead-letter queue with replay, a nightly digest, worker health with Prometheus output (migration `0016`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Claude |
| 2026-10-02 | **Phase 13 to 13/15.** Frontend: Vitest + Testing Library + MSW in both apps (≈1,270 tests; storefront 99.8%, admin 99.9%), which found a retry button submitting the product form, duplicate filter ids, and "1 seconds". Playwright: six journeys × Chromium, Firefox, WebKit with axe on every page — 18/18, zero violations, after darkening the light-mode status colours and fixing a confirmation page that reported a decline after a later card succeeded. API: a sandbox payment provider (migration `0017`, refused in production); webhook and cart/discount concurrency suites; schemathesis contract tests, for which the OpenAPI document now declares RFC 9457 errors and non-JSON responses — they found NUL characters causing 500s (now 422) and Stripe/Paystack crashing on signed malformed events. Coverage gate 85% (measured 89%). CI: compose-based infrastructure, contract and E2E jobs; a manual k6 workflow. k6 locally: zero oversells, p95 thresholds missed under a one-SKU rush.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Claude |
| 2026-10-04 | **Email verification finished.** It had been left on the Phase 5 inline path: sent during `/register` over SMTP, which in production (Resend, no SMTP host) failed silently, and outside the email log, retries and rate limits. It now goes through the outbox like every other customer email, and the worker mints the link when it sends. The request path's mailer (password reset, lockout, password changed, staff invite) and the worker's ops alerts now use the configured transport, so Resend in production; the unused `SmtpMailer` is removed. Tests: queued not sent inline, sent once, dropped if verified first, retried after a provider failure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2026-10-04 | **Phase 14 to 10/13.** API: gzip, ETag/304 on public catalog and search, N+1 and plan review (`docs/PERFORMANCE.md`, migration 0018). Storefront: sitemap, robots, canonical/OG/Twitter metadata, Organization/WebSite/BreadcrumbList JSON-LD, responsive AVIF/WebP images with blurhash, preconnects, and the radix-ui barrel fix (home 214 → 135 kB). Lighthouse CI job added. Left: page-level ISR (every route is dynamic because the root layout reads the session), the first Lighthouse run, and a CWV check on a throttled device.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
