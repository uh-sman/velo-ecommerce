# Discovery & Definition

> **Phase 0 deliverable.** The decisions here are the expensive ones — the ones that cost days to change in Phase 2 and weeks to change in Phase 8. They are written down so that "why is it like this?" has an answer six months from now, and so that changing any of them is a visible decision rather than a quiet drift.
>
> **Status:** agreed. **Last reviewed:** 2026-09-24.

---

## Table of contents

- [1. The product](#1-the-product)
- [2. Personas](#2-personas)
- [3. Critical user journeys](#3-critical-user-journeys)
- [4. Out of scope for v1](#4-out-of-scope-for-v1)
- [5. Launch catalog shape](#5-launch-catalog-shape)
- [6. Definition of success](#6-definition-of-success)
- [7. Non-functional requirements](#7-non-functional-requirements)
- [8. Privacy, retention, and compliance](#8-privacy-retention-and-compliance)
- [9. Risk register](#9-risk-register)
- [10. Open questions](#10-open-questions)

---

## 1. The product

**One sentence:**

> **Velo Commerce is a self-hostable, headless online store that is correct about money and inventory under concurrency, and pleasant to shop on a mid-range phone.**

Validated against the README: the README promises server-authoritative pricing, oversell-proof inventory, idempotent payments, webhook-confirmed orders, and an accessible, fast storefront. The sentence above is the compression of those five claims. If a proposed feature does not serve one of them, it belongs in [§4](#4-out-of-scope-for-v1).

**What it is not:** a marketplace, a CMS, a subscription biller, or a theme platform. Each of those is a different product with a different data model, and trying to be any of them in v1 would compromise the commerce core.

---

## 2. Personas

Three personas, because three is what the system actually serves. A fourth would be invention.

### 2.1 Shopper — "Ada"

Buys on a phone, on mobile data, usually in the evening, usually distracted. Has abandoned three carts this month, twice because a form asked for something she did not want to give.

|                   |                                                                                                                                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Goal**          | Find the right item, in the right variant, in stock, and pay in under three minutes without creating an account.                                                                                          |
| **Context**       | Mid-range Android, 4G, one hand, screen between 360px and 414px wide.                                                                                                                                     |
| **Frustrations**  | Forced registration. A price that changes at the payment step. "Add to cart" that silently fails. Being told an item is in stock and then emailed an apology. Checkout forms that ask for a company name. |
| **Needs from us** | Guest checkout, honest stock, a total that never moves, and a confirmation she can trust.                                                                                                                 |
| **Measured by**   | Conversion rate, cart-abandonment rate, checkout completion time, INP on add-to-cart.                                                                                                                     |

### 2.2 Store Operator — "Tunde"

Runs the shop. Not technical. Will never open a terminal, and must never need to. Works from the admin dashboard on a laptop, occasionally from a phone when something is urgent.

|                   |                                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Goal**          | Add products, fix a price, see what sold, fulfil today's orders, and refund a customer without asking a developer.                                                                                                  |
| **Context**       | Admin dashboard, desktop browser, 20–80 orders a day at launch.                                                                                                                                                     |
| **Frustrations**  | Anything that requires a developer. Bulk edits that are one-at-a-time. Not knowing which orders are paid but unfulfilled. Refunds that cannot be done per line item. An inventory count he cannot trust or explain. |
| **Needs from us** | Product and variant CRUD with bulk import, a clear order pipeline, partial fulfilment, per-line refunds, movement history that explains every stock number, and an audit log of staff changes.                      |
| **Measured by**   | Zero database access required in normal operation; time to fulfil an order; time to add a six-variant product.                                                                                                      |

### 2.3 Developer / Integrator — "Sam"

Builds against the API — a mobile app, a kiosk, a marketplace sync, or a replacement storefront.

|                   |                                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Goal**          | Integrate without reading the backend source or guessing at response shapes.                                                                                                                                             |
| **Context**       | Consumes the versioned HTTP API through the generated typed client.                                                                                                                                                      |
| **Frustrations**  | Undocumented error shapes. Endpoints that return `200` on failure. Breaking changes shipped without a version bump. Idempotency that is documented but not implemented. Pagination that changes shape between endpoints. |
| **Needs from us** | OpenAPI that is generated rather than hand-written, RFC-9457 errors, one pagination shape everywhere, real idempotency keys, and a deprecation policy.                                                                   |
| **Measured by**   | Time from API key to first order placed via the API; number of questions that required reading source.                                                                                                                   |

**Rule:** every feature in `PLANNING.md` names the persona it serves. A feature that serves none of the three is a feature nobody asked for.

---

## 3. Critical user journeys

Five journeys carry the business; everything else is supporting cast. Each is mapped end to end **with its failure branch**, because the failure branch is where the money is lost.

### 3.1 Discover

`Land → browse collection → filter/sort → search → open product`

- **Entry points:** organic search to a product or collection page, direct, paid social to a collection.
- **Must be true:** product and collection pages are server-rendered, indexable, and share-ready (OG tags, structured data). Search tolerates typos. Filters do not reload the page or lose state on back-navigation.
- **Fails when:** search is slow or literal, or the page shifts as images load.
- **Measured by:** search → product click-through, LCP on collection and product pages, bounce rate.

### 3.2 Evaluate

`Product page → choose variant → check stock → add to cart`

- **Must be true:** the variant matrix shows which combinations exist and which are out of stock _before_ selection. Stock is live, not cached to staleness. Price updates with the variant. Add-to-cart is optimistic in the UI but reconciled against the server.
- **Fails when:** a customer can select a combination that does not exist, or add an item that is not actually available.
- **Measured by:** add-to-cart rate, INP on the variant selector, rate of add-to-cart rejections.

### 3.3 Purchase — **the journey that matters**

`Cart → contact → shipping address → shipping method → payment → review → pay → confirmation`

- **Must be true:** the cart is re-priced server-side on every mutation and again immediately before capture. Inventory is _reserved_ with a TTL when checkout begins. The displayed total and the captured amount are the same number, always. The order is created by the signed webhook, never by the redirect.
- **Fails when:** payment succeeds and no order exists (→ reconciliation sweep closes it within 15 minutes), the webhook duplicates (→ idempotency), or two shoppers race for the last unit (→ row lock plus reservation: one order, one honest refusal).
- **Measured by:** checkout completion rate, step-level drop-off, duplicate-charge count (target: zero), oversell count (target: zero), payment failure rate.

### 3.4 Receive

`Order confirmation → email → fulfilment → shipped notification → tracking → delivered`

- **Must be true:** the confirmation email is transactional, immediate, and contains everything needed to get support. Partial fulfilment is visible to the customer, not hidden. Order status is self-serve, including for guests (signed link, no account required).
- **Fails when:** status is only reachable by emailing support, or a partially shipped order displays as fully shipped.
- **Measured by:** "where is my order?" contacts per 100 orders.

### 3.5 Return / Refund

`Request return → RMA issued → item returned → inspected → refund issued → refund confirmed`

- **Must be true:** refunds validate against the capture ledger — never more than was captured, per line item. Every refund writes to the audit trail with the operator who issued it. Inventory returns to stock on inspection, not on RMA creation.
- **Fails when:** a refund is issued twice, or returned stock is resold before it is physically back.
- **Measured by:** refund processing time, refund-related chargebacks (target: zero).

---

## 4. Out of scope for v1

Recorded as decisions, with reasons. Each sits in the `PLANNING.md` backlog. The point of this list is that adding any of them is a scope _change_ with a visible cost, not a quiet afternoon.

| Excluded                           | Why                                                                                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-vendor marketplace           | Needs vendor identity, split payouts, per-vendor fulfilment and reporting throughout. A different product, not a feature.                    |
| Subscriptions & recurring billing  | A second payment lifecycle (mandates, dunning, proration) alongside the one-off one. Doubles payment complexity for zero launch revenue.     |
| Multi-currency pricing             | Money carries a currency code, but there is no price book or FX. Rounding and display per locale is its own project. Single currency for v1. |
| Multi-warehouse inventory          | Inventory is one location per variant. A location dimension touches reservations, fulfilment routing, and every stock query.                 |
| B2B: quotes, POs, net terms        | Requires customer-specific pricing and an approval workflow — a different buying model from the one checkout is designed for.                |
| Loyalty, store credit, gift cards  | Each is a second tender type, so payment allocation stops being "one intent, one order".                                                     |
| Native mobile apps                 | The API is headless and ready for them. Building them is a separate track with separate release machinery.                                   |
| Headless CMS for editorial         | Merchandised blocks are configured in admin. Full editorial workflow is a CMS — integrate one later, do not write one.                       |
| A/B testing framework              | Needs traffic we will not have at launch. Revisit once conversion has a stable baseline.                                                     |
| Recommendations / personalisation  | Needs behavioural data we will not have at launch. "Related products" in v1 is rule-based and honest about it.                               |
| ERP / accounting / POS integration | Integration surface is customer-specific. Ship the export first; integrate when a real customer names the system.                            |
| Real-time push (WebSockets)        | Polling and revalidation suffice at v1 traffic. A push layer is additive later.                                                              |

---

## 5. Launch catalog shape

Sizing decisions — index strategy, search configuration, image pipeline, pagination defaults — all follow from this. These are **launch assumptions, to be validated against the first real catalog import** before Phase 6 begins.

| Dimension                 |                                       Launch | 12 months | Design headroom                   |
| ------------------------- | -------------------------------------------: | --------: | --------------------------------- |
| Products                  |                                          500 |     5,000 | 50,000 without re-architecture    |
| Variants per product      |           1–24 (typ. 6: 3 sizes × 2 colours) |      same | 100 max, enforced                 |
| Total variants            |                                       ~3,000 |   ~30,000 | 500,000                           |
| Images per product        |                                          4–8 |      same | 20 max                            |
| Collections               |                                           20 |       100 | unbounded                         |
| Facet dimensions          | 5 (price, size, colour, brand, availability) |         8 | Meilisearch handles 20+           |
| Catalog originals on disk |                                       ~12 GB |   ~120 GB | Object storage; never in Postgres |

**Consequences of this shape:**

- 3,000 variants fit comfortably in a single Meilisearch index with sub-50 ms faceted search. Sharding is not a v1 concern.
- The full catalog is small enough to warm a Redis cache entirely, so collection pages can be cached aggressively with tag-based invalidation on product write.
- Variant depth of ≤ 24 means the variant matrix can be sent whole to the product page. No lazy variant loading in v1.
- Image derivatives (AVIF + WebP × 4 widths) mean ~40 derived files per product. The pipeline must be async and idempotent from day one.

**If the real catalog is 10× this**, revisit before Phase 6: index partitioning, cursor-only pagination in admin, and a background reindex strategy. Tracked as R15.

---

## 6. Definition of success

### 6.1 Business metrics

Targets, not predictions. They exist so that "is this working?" has a numeric answer, and so that the CI performance budgets have a commercial justification.

| Metric                               |       Launch target | 12-month target | Why this number                                                                                                   |
| ------------------------------------ | ------------------: | --------------: | ----------------------------------------------------------------------------------------------------------------- |
| Conversion rate (session → order)    |                1.5% |            2.5% | Median for small specialty retail is 1.5–2%; a checkout designed this carefully should beat median, not match it. |
| Cart-abandonment rate                |               < 70% |           < 60% | Retail baseline is ~70%. Guest checkout and minimum-field checkout are the two levers.                            |
| Checkout completion (started → paid) |               > 60% |           > 75% | The step most under our control. Below 60% is the form's fault, not the market's.                                 |
| Average order value                  | Baseline in month 1 |            +10% | Free-shipping threshold and cross-sell are the levers.                                                            |
| Mobile share of orders               |               ≥ 60% |           ≥ 65% | Drives the mobile-first mandate in Phase 2.                                                                       |
| Support contacts per 100 orders      |                 < 5 |             < 2 | A proxy for whether the system explains itself.                                                                   |

### 6.2 Technical SLOs

Breaching an SLO is an incident, not a discussion. Each names the phase that owns it.

| SLO                                | Target                                            | Measured how                            | Owner phase |
| ---------------------------------- | ------------------------------------------------- | --------------------------------------- | ----------- |
| API availability                   | 99.9% monthly (≤ 43 min downtime)                 | Uptime check on `/ready`, 30 s interval | 16          |
| API latency                        | p95 < 200 ms, p99 < 500 ms (excluding PSP calls)  | Server-side histogram per route         | 16          |
| Storefront LCP                     | p75 < 2.0 s on 4G mid-range Android               | RUM + Lighthouse CI                     | 14          |
| Oversells                          | **Zero.** Not "few".                              | Nightly inventory ledger reconciliation | 7           |
| Duplicate charges                  | **Zero.**                                         | Payment ledger uniqueness check         | 8           |
| Stranded payments (paid, no order) | Zero after reconciliation; < 15 min window before | Reconciliation job alert                | 8           |
| Webhook processing                 | p95 ack < 500 ms; dead-letter queue empty         | Queue depth alert                       | 8           |
| Order email delivery               | 99% within 60 s of paid                           | Provider delivery webhook               | 12          |
| Data durability                    | PITR, RPO ≤ 5 min, RTO ≤ 1 h                      | Quarterly restore drill                 | 17          |

**The two zeros are the project.** Availability can degrade and be forgiven. An oversell or a double charge is a broken customer relationship and, at volume, a chargeback ratio.

### 6.3 Core Web Vitals budgets

Enforced in CI by Lighthouse CI; a regression fails the build. `docs/DESIGN-SYSTEM.md` §7 is the source of truth for the full budget set including bundle sizes; the headline metrics are repeated here because they are commitments, not implementation detail.

| Metric                   | Budget   |
| ------------------------ | -------- |
| LCP                      | < 2.0 s  |
| INP                      | < 200 ms |
| CLS                      | < 0.1    |
| TTFB                     | < 600 ms |
| Lighthouse Performance   | ≥ 95     |
| Lighthouse Accessibility | 100      |

---

## 7. Non-functional requirements

### 7.1 Expected load

Sizing inputs for connection pools, worker counts, rate limits, and the scaling path in `docs/ARCHITECTURE.md` §9.

|                               | Launch | 12 months | Peak event (flash sale / holiday) |
| ----------------------------- | -----: | --------: | --------------------------------: |
| Orders/hour (average)         |      3 |        40 |                               400 |
| Orders/hour (peak)            |     25 |       200 |                             2,000 |
| Concurrent sessions (average) |     20 |       250 |                             3,000 |
| Concurrent sessions (peak)    |    150 |     1,200 |                            10,000 |
| API req/s (average)           |      5 |        60 |                               600 |
| API req/s (peak)              |     40 |       300 |                             2,500 |
| Read:write ratio              |  ~95:5 |     ~95:5 |                             ~98:2 |
| Admin concurrent users        |      3 |        12 |                                20 |

**Consequences:**

- Peak 12-month write load (~200 orders/hour) is trivial for a single Postgres primary. **The primary is not the constraint; the checkout hot path is.**
- The read:write ratio justifies a read replica for catalog queries before it justifies anything else. Checkout reads stay on the primary — no replica lag in a payment path, ever.
- 2,500 req/s at flash-sale peak calls for CDN caching of collection and product pages with tag invalidation, not more API instances.
- Rate limits are derived from the peak _per-user_ rate, not the aggregate: a shopper cannot legitimately sustain more than ~2 req/s.

### 7.2 Availability and recovery

| Requirement                          | Value                                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Planned downtime for deploys         | **Zero.** Expand/contract migrations; rolling deploys.                                                                                                       |
| Maximum acceptable checkout downtime | 15 minutes before it is a Sev-1                                                                                                                              |
| RPO (data loss tolerance)            | 5 minutes                                                                                                                                                    |
| RTO (time to restore)                | 1 hour                                                                                                                                                       |
| Backup verification                  | Quarterly restore drill into a scratch environment — an untested backup is a hope, not a backup                                                              |
| Degraded modes                       | Search down → Postgres fallback query. Redis down → cache bypass; reservations fail closed. PSP down → honest retry message, cart and reservation preserved. |

**Fail closed on money, fail open on browsing.** If Redis is unavailable the catalog still serves from Postgres, but a reservation that cannot be recorded must reject the checkout rather than proceed unprotected.

### 7.3 Accessibility

**WCAG 2.1 Level AA. Non-negotiable, gated in CI.**

| Requirement                                                         | Enforcement                                          |
| ------------------------------------------------------------------- | ---------------------------------------------------- |
| Contrast: 4.5:1 body, 3:1 large text and UI boundaries, both themes | Token-level verification, `docs/DESIGN-SYSTEM.md` §2 |
| Every interactive element keyboard reachable and operable           | axe-core in E2E, Phase 13                            |
| Visible focus everywhere, `:focus-visible`, 2px ring                | Design system spec plus review                       |
| Lighthouse Accessibility = 100 on all storefront routes             | Lighthouse CI, build-fails                           |
| Screen-reader pass over the full purchase journey                   | Manual, NVDA + VoiceOver, Phase 13                   |
| `prefers-reduced-motion` respected by every animation               | Design system spec                                   |
| Forms: label, error association, live-region announcement           | Component spec                                       |

Accessibility failures block a release exactly as a failing test does. The checkout must be completable by keyboard alone, with a screen reader, with motion disabled, at 200% zoom.

### 7.4 Browser and device support

| Tier                    | Targets                                                                                                | Commitment                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| **A — fully supported** | Last 2 versions of Chrome, Safari, Firefox, Edge; iOS Safari 16+; Android Chrome on mid-range hardware | All features; all tests run here                  |
| **B — functional**      | Older evergreen (last 4 versions)                                                                      | Purchase journey works; visual polish may degrade |
| **C — unsupported**     | IE; browsers without ES2020 or CSS custom properties                                                   | Not tested, not blocked                           |

**Reference device for all performance work:** a mid-range Android over throttled 4G. Not a developer laptop on office wifi.

---

## 8. Privacy, retention, and compliance

### 8.1 Data classification

| Class                     | Examples                      | Handling                                                                                                                            |
| ------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Payment data**          | PAN, CVC, expiry              | **Never touches our servers.** Collected by the provider's hosted element; we store the provider token and last-4 for display only. |
| **PII**                   | Name, email, phone, addresses | Encrypted at rest, TLS in transit, never logged, redacted in error reports                                                          |
| **Sensitive operational** | Order history, cart contents  | Access-controlled; admin reads are audit-logged                                                                                     |
| **Public**                | Catalog, prices, collections  | Cacheable at the CDN                                                                                                                |

**No card data in any log, span, error report, or analytics event.** A CI log scanner asserts this, and it is on the Phase 8 launch checklist.

### 8.2 Retention schedule

| Data                      | Retention                                          | Basis                                                                         |
| ------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------- |
| Order and payment records | 7 years                                            | Tax and audit obligation — overrides erasure requests, per GDPR Art. 17(3)(b) |
| Customer account PII      | Life of account + 30 days after a deletion request | Deletion anonymises; orders survive with a non-identifying reference          |
| Abandoned carts           | 90 days                                            | Recovery window, then purge                                                   |
| Inventory movements       | 7 years                                            | The ledger reconciles stock; it cannot be pruned independently                |
| Audit log                 | 3 years                                            | Dispute and forensics window                                                  |
| Application logs          | 30 days hot, 1 year cold                           | Incident investigation                                                        |
| Webhook payloads          | 90 days                                            | Replay and reconciliation window                                              |
| Analytics events          | 14 months                                          | Year-over-year comparison, then aggregate                                     |
| Backups                   | 30 days PITR + monthly snapshots for 12 months     | The RPO/RTO commitment above                                                  |

### 8.3 Privacy rights (GDPR / NDPR)

| Right                  | Implementation                                                                             | Endpoint               |
| ---------------------- | ------------------------------------------------------------------------------------------ | ---------------------- |
| Access / portability   | Async export, machine-readable, delivered as a signed link by email                        | `POST /account/export` |
| Erasure                | Anonymise the user row; retain orders under a non-identifying reference                    | `DELETE /account`      |
| Rectification          | Self-serve in the account area                                                             | Account endpoints      |
| Consent                | Cookie banner: essential vs analytics vs marketing; opt-in for non-essential, withdrawable | Storefront, Phase 10   |
| Objection to marketing | One-click unsubscribe in every marketing email; transactional email is not marketing       | Phase 12               |

**Erasure anonymises rather than deletes**, because financial records must survive. The privacy notice says so in plain language — a right that is silently limited is worse than one that is honestly bounded.

**Published documents required before launch (Phase 17):** privacy notice, cookie policy, terms of sale, refund and returns policy, shipping policy. Each linked from the footer and from checkout.

### 8.4 PCI-DSS scope

**Target: SAQ-A — the smallest possible scope.**

Achievable only if **every** card field renders inside the provider's iframe or hosted page, and our code never sees, transports, or stores a PAN.

| SAQ-A requirement            | How the architecture guarantees it                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| No card data on our systems  | Stripe Payment Elements / provider hosted fields only. No custom card inputs, ever — a hard architectural rule, not a preference. |
| Payment page served securely | HTTPS everywhere, HSTS, CSP restricting script sources to the provider                                                            |
| No card data in logs         | Structured logging with a deny-list; CI log scanner on the launch checklist                                                       |
| Provider is PCI-DSS Level 1  | Stripe and the secondary provider both are; attestations filed                                                                    |
| Annual self-assessment       | SAQ-A completed and filed before launch (Phase 17)                                                                                |

**The moment anyone proposes a custom card form, compliance scope jumps from SAQ-A to SAQ-D** — a different order of cost and audit burden. The answer is no. `docs/PAYMENTS-AND-CHECKOUT.md` §9 holds the detail.

---

## 9. Risk register

Likelihood × impact, with a named mitigation and the phase that owns it. **Reviewed at the end of every phase**; changes recorded in the change log below.

| #   | Risk                                         | Impact | Likelihood | Exposure | Mitigation                                                                                                                                  | Owner phase |
| --- | -------------------------------------------- | ------ | ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| R1  | Overselling under concurrency                | High   | Medium     | **High** | `SELECT … FOR UPDATE` on the variant row, TTL reservations, and a concurrency suite that races real transactions                            | 7           |
| R2  | Duplicate charges                            | High   | Medium     | **High** | Idempotency key required on every money-moving endpoint, persisted with its response; unique constraint on `(provider, provider_intent_id)` | 8           |
| R3  | Lost webhooks → paid orders never created    | High   | Medium     | **High** | Reconciliation sweep every 15 min, dead-letter queue, alert on non-empty DLQ                                                                | 8           |
| R4  | Payment provider outage                      | High   | Low        | Medium   | Second adapter behind the `PaymentProvider` interface; circuit breaker; honest retry UX that preserves cart and reservation                 | 8           |
| R5  | Slow catalog as SKUs grow                    | Medium | High       | **High** | Meilisearch, Redis cache, reviewed index strategy; `EXPLAIN ANALYZE` in PRs touching queries                                                | 6           |
| R6  | Scope creep past launch date                 | Medium | High       | **High** | The out-of-scope list in §4 is agreed; changes go to the backlog with a stated cost                                                         | standing    |
| R7  | Secrets leaked to the repository             | High   | Low        | Medium   | gitleaks in pre-commit and CI; secrets only from the platform secret store                                                                  | 15          |
| R8  | Price tampering by a modified client         | High   | Low        | Medium   | Server-authoritative pricing; totals re-derived before capture; client prices are display-only                                              | 7           |
| R9  | Tax calculated wrongly                       | High   | Medium     | **High** | Configurable rules, pluggable provider, and rates **confirmed with an accountant before launch — not guessed**                              | 8 / 17      |
| R10 | Accessibility retrofit discovered late       | Medium | Medium     | Medium   | AA gated in CI from Phase 3, not audited at the end                                                                                         | 2 / 13      |
| R11 | Migration causes downtime or data loss       | High   | Low        | Medium   | Expand/contract only; every migration has a tested down path; quarterly restore drill                                                       | 4 / 17      |
| R12 | Single-maintainer bus factor                 | Medium | Medium     | Medium   | ADRs, this document, and `PLANNING.md` exist so the reasoning outlives the author                                                           | standing    |
| R13 | Email deliverability (confirmations in spam) | Medium | Medium     | Medium   | SPF/DKIM/DMARC configured and verified pre-launch; transactional provider with delivery webhooks; monitored delivery rate                   | 12 / 17     |
| R14 | Fraud and chargebacks                        | Medium | Medium     | Medium   | Provider fraud tooling enabled; 3-D Secure for SCA; velocity limits on checkout attempts                                                    | 8 / 15      |
| R15 | Catalog 10× larger than §5 assumes           | Medium | Medium     | Medium   | Validate against the real import before Phase 6; index partitioning path documented                                                         | 6           |

**Exposure is the working priority.** High-exposure risks get a mitigation _verified by a test_, not merely a plan: R1, R2, R3, and R8 all have explicit cases in the Phase 13 test matrix.

---

## 10. Open questions

Not yet decided, with the phase by which each must be. An open question still open past its deadline becomes a risk.

| #   | Question                                                             | Needed by | Consequence of not deciding                                            |
| --- | -------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------- |
| Q1  | Which currency and tax jurisdiction does v1 launch in?               | Phase 4   | Determines the tax rule set and money display format throughout        |
| Q2  | Secondary payment provider — Paystack or Flutterwave?                | Phase 8   | Affects only the second adapter; the interface is provider-agnostic    |
| Q3  | Real catalog size and variant depth from the first import            | Phase 6   | Validates or invalidates §5, and with it the search and index strategy |
| Q4  | Transactional email provider (Resend / Postmark / SES)               | Phase 12  | Deliverability, and the DNS records needed before launch               |
| Q5  | Hosting platform for the API — Fly.io or Railway                     | Phase 17  | Affects deploy machinery, not architecture                             |
| Q6  | Is the returns/RMA workflow needed at launch or in the first update? | Phase 9   | Phase 9 scope; the data model supports it either way                   |
| Q7  | Who signs off the tax rates with an accountant?                      | Phase 17  | R9 cannot be closed without a name against it                          |

---

## Change log

| Date       | Change                                                                                                                                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-24 | Initial discovery record: personas, journeys, catalog shape, business metrics, SLOs, load projections, retention schedule, PCI scope, and a 15-item risk register. The register supersedes the 7-item table previously inline in `PLANNING.md`. |
