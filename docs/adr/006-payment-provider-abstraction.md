# ADR-006 — Stripe as primary PSP behind a `PaymentProvider` interface

|              |                  |
| ------------ | ---------------- |
| **Status**   | Accepted         |
| **Date**     | 2026-09-20       |
| **Deciders** | Project lead     |
| **Related**  | ADR-005, ADR-010 |

---

## Context

The payment provider is the single hardest dependency in the system to replace once code is written against it, and the one whose outage is most expensive (`DISCOVERY.md` R4: a provider outage is high impact). It is also the component that determines our PCI-DSS scope: SAQ-A is only achievable if card fields render inside the provider's own iframe and never touch our servers (`DISCOVERY.md` §8.4).

There is a second force. Stripe's coverage is excellent in Europe and North America and thin for the payment methods that matter in West Africa — bank transfer, USSD, and mobile money — which regional providers such as Paystack and Flutterwave handle natively. A store that cannot take the payment method its customers actually use does not have a payment problem, it has a revenue problem.

So the decision is really two: which provider to build against first, and how much insulation to put between that provider and the rest of the system.

## Options considered

| Option                                              | Summary                                | Verdict     |
| --------------------------------------------------- | -------------------------------------- | ----------- |
| **A — Stripe behind a `PaymentProvider` interface** | One implementation now, a defined seam | ✅ Chosen   |
| **B — Stripe directly, no abstraction**             | Call the SDK from services             | ❌ Rejected |
| **C — Two live providers from day one**             | Stripe and Paystack both in v1         | ❌ Rejected |
| **D — Aggregator** (e.g. a unified payments API)    | Someone else's abstraction             | ❌ Rejected |

### A — Stripe behind an interface

A narrow protocol — `create_intent`, `capture`, `refund`, `verify_webhook`, `parse_event` — with Stripe as the only implementation at launch. Every provider-specific type stays inside the adapter; services speak in our own `PaymentIntent` and `PaymentEvent` types, in the money representation of ADR-005.

The interface is narrow deliberately. A wide one that exposes every Stripe capability is not an abstraction, it is Stripe with extra steps.

Stripe is the primary because Payment Elements gives cards, Apple Pay, Google Pay, and Link in one integration, handles SCA and 3-D Secure inside the hosted element, has the best-documented webhook and idempotency semantics of any provider, and has test tooling good enough to build the Phase 8 test matrix against.

### B — Stripe directly

Less code today. The cost arrives all at once: adding a second provider means finding every `stripe.` call across services, and provider outages have no failover path (R4 unmitigated). Rejected — the interface is a few hundred lines and it is the mitigation for a high-impact risk.

### C — Two live providers at launch

Doubles the Phase 8 surface: two webhook verifiers, two idempotency semantics, two refund models, two test matrices — in the phase that already gates the critical milestone. Build the seam, ship one implementation, add the second when a real customer needs it. Rejected as scope.

### D — Aggregator

Trades our abstraction for someone else's, adds a party to every payment, and puts a third company between us and the money — with its own uptime, its own fees, and its own idea of what a refund means. Rejected.

## Decision

**We will integrate Stripe as the primary PSP, accessed exclusively through a `PaymentProvider` interface, with a second adapter (Paystack or Flutterwave — `DISCOVERY.md` Q2) implemented when regional coverage is needed.** No provider SDK type crosses the adapter boundary, in either direction.

The deciding reason is R4: a single-provider outage with no seam is an unmitigated high-impact risk, and the seam is cheap to build now and expensive to retrofit. Second: the interface forces us to define what a payment _means in our domain_, which is the thing that survives a provider change.

**Hard constraint, restated:** card fields render only in the provider's hosted element. Any proposal for a custom card form moves us from SAQ-A to SAQ-D and is refused (`DISCOVERY.md` §8.4).

## Consequences

**Good**

- Provider-specific code is confined to one directory with one test suite.
- A second provider is an implementation of a known interface, not a refactor of the checkout.
- The interface forces domain-level definitions of intent, capture, refund, and event — which is what makes provider-agnostic reconciliation possible.
- Tests substitute a fake provider, so the full checkout can be tested without network access.

**Bad**

- The interface is a lowest-common-denominator: provider-specific features (Stripe Tax, Radar rules, Link) either sit outside it or leak through a narrow escape hatch. Both options are ugly; the escape hatch is documented rather than pretended away.
- An extra indirection to trace when debugging a live payment.
- Maintaining the fake provider in step with real provider behaviour is ongoing work, and a fake that drifts gives false confidence.
- Webhook semantics differ enough between providers that `parse_event` will be the messiest part of the second adapter.

**Neutral**

- Idempotency (`docs/PAYMENTS-AND-CHECKOUT.md` §5) is implemented at our boundary as well as the provider's, so it holds regardless of which adapter is active.
- Failover between providers is manual in v1 — a circuit breaker that surfaces an honest retry message, not automatic re-routing of an in-flight payment.

## Revisit when

A second provider goes live and the interface needs widening, Stripe's regional coverage changes materially where our customers are, or provider outages exceed the availability SLO in `DISCOVERY.md` §6.2 often enough to justify automatic failover.
