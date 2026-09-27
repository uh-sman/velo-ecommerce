# ADR-010 — Orders are confirmed by webhook, never by client redirect

|              |                  |
| ------------ | ---------------- |
| **Status**   | Accepted         |
| **Date**     | 2026-09-20       |
| **Deciders** | Project lead     |
| **Related**  | ADR-006, ADR-009 |

---

## Context

After a payment succeeds at the provider, two things race to tell us about it: the customer's browser, redirected back to a confirmation URL, and the provider's server-to-server webhook. One of them must be the trigger that creates the paid order. This is the single highest-consequence decision in the checkout flow, because getting it wrong produces the two failure modes the project exists to prevent — a customer charged without an order, or an order created without a payment.

The browser redirect is unreliable in ways that are not edge cases at all. The customer closes the tab as soon as the bank confirms. Mobile Safari drops the return from a 3-D Secure interstitial. The network fails between the provider and the return URL. The customer's battery dies. Each is ordinary, and each loses the order if the redirect is what creates it.

The browser redirect is also **untrusted input**. A redirect URL that says "payment succeeded" can be typed into an address bar. Any order-creation path reachable from a client-controlled URL is a path to a free order.

The webhook has the opposite properties: it is signed, it is retried for up to three days with backoff, and it comes from the provider rather than from the customer. Its weakness is timing — it can arrive before, during, or seconds after the redirect, and occasionally it does not arrive at all.

## Options considered

| Option                                            | Summary                                         | Verdict     |
| ------------------------------------------------- | ----------------------------------------------- | ----------- |
| **A — Webhook creates the order; the page polls** | Single authoritative path, client reads only    | ✅ Chosen   |
| **B — Redirect creates the order**                | Confirmation page writes the order              | ❌ Rejected |
| **C — Whichever arrives first, deduplicated**     | Both paths write; idempotency resolves the race | ❌ Rejected |
| **D — Poll the provider from the client**         | Client asks the provider for status             | ❌ Rejected |

### A — Webhook creates, page polls

The signed webhook handler verifies the signature, acknowledges within milliseconds, and enqueues processing (ADR-009). The processor creates the order inside one transaction: order, line items, payment record, inventory movements, reservation release, discount redemption.

The confirmation page _creates nothing_. It polls a read-only status endpoint and shows "confirming your payment" until the order exists. If the customer closes the tab, the order is created anyway and the email still goes out. If the webhook is late, the page waits honestly. If the webhook never arrives, the reconciliation sweep (`docs/PAYMENTS-AND-CHECKOUT.md` §7) polls the provider for intents with no order and creates it within 15 minutes.

Three independent paths to the same outcome, exactly one of which can write.

### B — Redirect creates the order

The common tutorial pattern, and it loses orders in production at a rate proportional to mobile traffic. It is also the vulnerability described above: a client-reachable order-creation endpoint. Rejected outright.

### C — Both paths, deduplicated

Idempotency would make it _safe_ — the unique constraint on `(provider, provider_intent_id)` guarantees one order regardless of who wins the race. But it means two code paths that create orders, both of which must be equally correct, equally tested, and equally maintained, one of which is reachable from a client. It doubles the surface of the most critical transaction in the system to save the customer a few seconds of waiting.

Rejected — but the idempotency constraint that would have made it safe stays, because it is what makes duplicate _webhooks_ harmless.

### D — Client polls the provider

Puts provider credentials or a client-visible status check in the browser, and still needs a server write afterwards, which is option B with extra steps. Rejected.

## Decision

**An order transitions to paid only when a signature-verified provider webhook says so.** The confirmation page is read-only: it polls a status endpoint and renders what it finds. The reconciliation sweep is the backstop for webhooks that never arrive.

The deciding reason is that the redirect is both lossy and forgeable, while the webhook is signed and retried. Second: one write path is one thing to get right, and this is the transaction that matters most.

**Supporting guarantees, all required for this to hold:**

| Guarantee                                | Mechanism                                                                        |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| Duplicate webhooks are harmless          | Unique constraint on `(provider, provider_event_id)`; processing is idempotent   |
| Forged webhooks are rejected             | Signature verification against the provider secret, before any parsing           |
| Replayed webhooks are rejected           | Timestamp tolerance window plus event-ID uniqueness                              |
| Slow processing does not cause retries   | Acknowledge in under ~500 ms, process asynchronously (ADR-009)                   |
| Out-of-order events do not corrupt state | The checkout state machine rejects illegal transitions rather than applying them |
| A lost webhook still produces an order   | Reconciliation sweep every 15 minutes                                            |
| Permanently failing events are visible   | Dead-letter queue with an alert on non-empty (`DISCOVERY.md` R3)                 |

## Consequences

**Good**

- A paid order cannot be lost by a closed tab, a dropped network, or a failed redirect.
- No client-reachable path creates a paid order, so the "free order by URL" class of attack does not exist.
- Duplicate deliveries — which are routine, not exceptional — are provably harmless.
- Three independent recovery paths for the same outcome, with reconciliation as the floor.

**Bad**

- The confirmation page sometimes shows a waiting state for a second or two. Genuinely worse UX than an instant "thank you", and the correct trade.
- The webhook endpoint must be publicly reachable over HTTPS with a valid certificate, which makes local development need a tunnel (ngrok or the provider CLI) — documented in Phase 8 setup.
- More moving parts to operate: queue, dead-letter queue, reconciliation job, and alerting on all three. Each is one more thing that can be silently broken, which is why each has its own monitor.
- The polling endpoint needs rate limiting, or an abandoned confirmation tab polls forever.

**Neutral**

- The same mechanism is reused for refunds, disputes, and payout events — the webhook pipeline is built once.
- Adding a second provider (ADR-006) means a second signature verifier and event parser, but no change to this rule.

## Revisit when

Never for the principle; it is the project's core correctness claim. The _implementation_ is revisited if a provider offers a stronger synchronous confirmation primitive, or if reconciliation lag becomes commercially significant — in which case the answer is to shorten the sweep interval, not to let the browser create orders.
