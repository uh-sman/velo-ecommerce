# Payments & Checkout

The highest-risk subsystem in the project. Read this before writing any of it.

---

## 1. Principles

These are not guidelines. Violating any one of them is a defect, not a trade-off.

| #   | Principle                                                                                                                | Consequence of ignoring it                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| 1   | **The client never states a price.** Amounts are recomputed from the database immediately before the provider is called. | A customer buys a laptop for one cent.                           |
| 2   | **Orders are created by webhooks, never by redirects.**                                                                  | The customer closes the tab after paying; money taken, no order. |
| 3   | **Every money endpoint is idempotent.**                                                                                  | A double-clicked button charges twice.                           |
| 4   | **Webhook signatures are verified against the raw body, before parsing.**                                                | Anyone who discovers the URL marks their orders paid for free.   |
| 5   | **Stock is reserved, not merely checked.**                                                                               | Two buyers, one unit, two orders.                                |
| 6   | **Card data never touches our infrastructure.**                                                                          | PCI-DSS scope explodes from SAQ-A to SAQ-D.                      |
| 7   | **Every state change is recorded.**                                                                                      | A disputed transaction cannot be explained.                      |
| 8   | **Reconciliation exists.** Webhooks get lost.                                                                            | A paid customer never receives an order.                         |

---

## 2. Checkout state machine

```
                     ┌───────────┐
                     │ initiated │  cart snapshotted, stock reserved (30 min TTL)
                     └─────┬─────┘
                           │ PATCH /address
                     ┌─────▼───────┐
                     │ address_set │  shipping rates now calculable
                     └─────┬───────┘
                           │ PATCH /shipping
                     ┌─────▼────────┐
                     │ shipping_set │  totals final; tax computed
                     └─────┬────────┘
                           │ POST /payment-intent
                   ┌───────▼─────────┐
                   │ payment_pending │  provider intent created
                   └───┬────────┬────┘
        webhook:       │        │      webhook: payment_intent.payment_failed
        succeeded      │        │
              ┌────────▼──┐  ┌──▼──────┐
              │ confirmed │  │ failed  │  reservation released, cart intact,
              └───────────┘  └────┬────┘  customer may retry
              order created       │
              stock committed     └──────▶ back to payment_pending on retry

  Any non-terminal state + TTL elapsed ──▶ expired  (reservation released)
```

**Every transition is validated server-side.** A request to set a shipping method on a `confirmed` session is rejected with `409`, not tolerated. The state machine is a table of allowed `(from, to)` pairs, and anything absent from that table is an error.

```python
ALLOWED: dict[Status, set[Status]] = {
    Status.INITIATED:       {Status.ADDRESS_SET, Status.EXPIRED, Status.ABANDONED},
    Status.ADDRESS_SET:     {Status.ADDRESS_SET, Status.SHIPPING_SET, Status.EXPIRED, Status.ABANDONED},
    Status.SHIPPING_SET:    {Status.ADDRESS_SET, Status.SHIPPING_SET, Status.PAYMENT_PENDING,
                             Status.EXPIRED, Status.ABANDONED},
    Status.PAYMENT_PENDING: {Status.CONFIRMED, Status.FAILED, Status.EXPIRED},
    Status.FAILED:          {Status.PAYMENT_PENDING, Status.EXPIRED},
    Status.CONFIRMED:       set(),   # terminal — an order exists
    Status.EXPIRED:         set(),
    Status.ABANDONED:       set(),
}
```

Note that `ADDRESS_SET → ADDRESS_SET` is allowed: customers change their mind about the delivery address, and that must not be an error.

---

## 3. The happy path, end to end

```
CUSTOMER          STOREFRONT           API                  POSTGRES          STRIPE
    │                  │                │                       │                │
    │ "Checkout"       │                │                       │                │
    ├─────────────────▶│                │                       │                │
    │                  │ POST /checkout │                       │                │
    │                  ├───────────────▶│                       │                │
    │                  │                │ BEGIN                 │                │
    │                  │                │ lock inventory rows   │                │
    │                  │                ├──────────────────────▶│                │
    │                  │                │ insert reservations   │                │
    │                  │                │ snapshot priced cart  │                │
    │                  │                │ COMMIT                │                │
    │                  │◀───────────────┤                       │                │
    │                  │ session + totals                       │                │
    │                  │                │                       │                │
    │ address, shipping│                │                       │                │
    ├─────────────────▶├───────────────▶│ recompute tax+total   │                │
    │                  │◀───────────────┤──────────────────────▶│                │
    │                  │                │                       │                │
    │ "Pay"            │                │                       │                │
    ├─────────────────▶│ POST /payment-intent                   │                │
    │                  │  Idempotency-Key: <uuid>               │                │
    │                  ├───────────────▶│                       │                │
    │                  │                │ ── RECOMPUTE TOTAL ──▶│                │
    │                  │                │ ◀── authoritative ────┤                │
    │                  │                │ insert payment(pending)                │
    │                  │                ├──────────────────────▶│                │
    │                  │                │ create intent (that amount)            │
    │                  │                ├───────────────────────────────────────▶│
    │                  │◀───────────────┤◀───────────────────────────────────────┤
    │                  │ client_secret  │                       │                │
    │                  │                │                       │                │
    │ card details, entered INSIDE the Stripe iframe ──────────────────────────▶ │
    │   (our server never sees these bytes)                     │                │
    │                  │                │                       │                │
    │◀── 3-D Secure challenge if required ──────────────────────────────────────▶│
    │                  │                │                       │                │
    │                  │                │◀── webhook: payment_intent.succeeded ──┤
    │                  │                │    (signature verified vs RAW body)    │
    │                  │                │ 200 OK immediately ───────────────────▶│
    │                  │                │                       │                │
    │                  │                │ ═══ ASYNC WORKER ═══  │                │
    │                  │                │ BEGIN                 │                │
    │                  │                │  commit reservations  │                │
    │                  │                │  decrement stock      │                │
    │                  │                │  insert movements     │                │
    │                  │                │  CREATE ORDER + items │                │
    │                  │                │  update payment       │                │
    │                  │                │  insert outbox event  │                │
    │                  │                │ COMMIT ──────────────▶│                │
    │                  │                │                       │                │
    │ redirect to /order/{number}       │                       │                │
    │◀─────────────────┤ polls until order exists (usually <1s) │                │
    │ confirmation email (via outbox relay)                     │                │
```

**The critical detail is the redirect.** The browser is sent to the confirmation page, but that page does not _create_ anything — it polls for an order that the webhook handler creates independently. If the customer closes the tab at that instant, the order is created anyway. If the webhook is slow, the page shows "confirming your payment" and keeps polling. If the webhook never arrives, reconciliation creates the order within 15 minutes and the customer gets their email.

The client-side path and the money path are completely decoupled. That is the whole design.

---

## 4. Payment provider abstraction

One interface, multiple providers. Swapping Stripe for Paystack is a configuration change, not a refactor.

```python
class PaymentProvider(Protocol):
    name: str

    async def create_intent(
        self,
        *,
        amount: int,              # minor units — NEVER from a request body
        currency: str,
        idempotency_key: str,
        metadata: dict[str, str],
    ) -> PaymentIntent: ...

    async def get_intent(self, intent_id: str) -> PaymentIntent: ...

    async def refund(
        self,
        *,
        charge_id: str,
        amount: int,
        reason: RefundReason,
        idempotency_key: str,
    ) -> Refund: ...

    def verify_webhook(self, raw_body: bytes, signature: str) -> WebhookEvent: ...
    #                              ^^^^^^^^ raw bytes, not a parsed dict.
    #   The signature covers the exact bytes sent. Re-serialising a parsed dict
    #   produces different bytes (key order, whitespace, unicode escaping) and
    #   the verification silently fails or, worse, is skipped "because it's broken".
```

| Provider        | Region                              | Methods                                 |
| --------------- | ----------------------------------- | --------------------------------------- |
| **Stripe**      | Global                              | Card, Apple Pay, Google Pay, Link, SEPA |
| **Paystack**    | Nigeria, Ghana, South Africa, Kenya | Card, bank transfer, USSD, mobile money |
| **Flutterwave** | Pan-African                         | Card, mobile money, bank transfer       |

Provider selection is by currency and customer country, resolved server-side at intent creation.

---

## 5. Idempotency

Required on `POST /checkout`, `POST /checkout/{id}/payment-intent`, and `POST /orders/{id}/refunds`.

```python
async def with_idempotency(key: UUID, endpoint: str, request_hash: str, fn):
    existing = await repo.get(key)

    if existing is None:
        await repo.insert_in_flight(key, endpoint, request_hash)
        try:
            status, body = await fn()
        except Exception:
            await repo.mark_failed(key)      # allows a clean retry
            raise
        await repo.complete(key, status, body)
        return status, body

    if existing.request_hash != request_hash:
        raise IdempotencyKeyReused()          # 422 — same key, different body = client bug

    if existing.status == "in_flight":
        raise RequestInProgress()             # 409 — retry shortly

    return existing.response_status, existing.response_body   # byte-identical replay
```

The `in_flight` state matters. Without it, two simultaneous requests carrying the same key both see "no record" and both execute. The insert of the `in_flight` row is the lock, and the primary key constraint makes it atomic.

The frontend generates the key once, when the customer lands on the payment step — **not** on each click. That way every retry of the same intent carries the same key.

---

## 6. Webhooks

### 6.1 The handler

```python
@router.post("/webhooks/stripe", status_code=200)
async def stripe_webhook(request: Request):
    raw = await request.body()                       # RAW bytes, before any parsing
    sig = request.headers.get("stripe-signature", "")

    try:
        event = provider.verify_webhook(raw, sig)    # constant-time HMAC comparison
    except SignatureError:
        log.warning("webhook.invalid_signature", ip=request.client.host)
        raise HTTPException(400, "Invalid signature")

    try:
        await repo.record_event(                     # UNIQUE (provider, provider_event_id)
            provider="stripe", event_id=event.id,
            event_type=event.type, payload=event.data,
        )
    except UniqueViolation:
        log.info("webhook.duplicate", event_id=event.id)
        return {"received": True}                    # already seen — ack and drop

    await queue.enqueue("process_payment_event", event.id)
    return {"received": True}                        # under 100ms, always
```

Three defences, in order: **verify**, **deduplicate**, **acknowledge fast**.

Acknowledging fast is not a performance nicety. Stripe times out at 20 seconds and retries with backoff for three days. A handler that does its work inline will, under load, be slow enough to trigger retries — which arrive as duplicates while the first is still running. Fast-ack plus async processing removes that failure mode entirely.

### 6.2 Events handled

| Event                           | Action                                                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `payment_intent.succeeded`      | Commit reservations, decrement stock, **create the order**, mark payment succeeded, emit `order.created` |
| `payment_intent.payment_failed` | Release reservations, mark payment failed, keep the cart, notify the customer                            |
| `payment_intent.canceled`       | Release reservations, expire the checkout session                                                        |
| `charge.refunded`               | Update refund status and `orders.refunded_amount`                                                        |
| `charge.dispute.created`        | Flag the order, alert staff, freeze fulfilment                                                           |
| `charge.dispute.closed`         | Record the outcome                                                                                       |

### 6.3 Out-of-order delivery

Webhooks are not ordered. A `succeeded` can arrive after a `failed` for the same intent — for example, a retried payment where the two deliveries cross.

The handler is written as a state machine over the _payment_ record, not as a sequence of steps:

```python
TERMINAL = {"succeeded", "cancelled"}

async def handle(event):
    payment = await repo.get_by_intent(event.intent_id, for_update=True)

    if payment.status in TERMINAL and event.new_status != payment.status:
        log.warning("webhook.out_of_order",
                    intent=event.intent_id, current=payment.status, incoming=event.new_status)
        return                       # already settled; ignore
    ...
```

Locking the payment row (`FOR UPDATE`) also serialises concurrent processing of two events for the same intent.

### 6.4 Dead-letter queue

After five failed processing attempts with exponential backoff, the event moves to the dead-letter queue, an alert fires, and `payment_events.processing_error` records why. A staff tool replays dead-lettered events after the underlying bug is fixed. Nothing is ever discarded silently.

---

## 7. Reconciliation — the safety net

Webhooks get lost. Providers have outages. Our API might be down for the five minutes the webhook was retried. Reconciliation is what makes that survivable.

**Every 15 minutes:**

```sql
SELECT * FROM payments
 WHERE status IN ('pending','processing','requires_action')
   AND created_at < now() - interval '30 minutes';
```

For each result, query the provider directly for the intent's true state:

| Provider says                 | Action                                                  |
| ----------------------------- | ------------------------------------------------------- |
| `succeeded`, no order exists  | Run the full order-creation path. **This is the save.** |
| `succeeded`, order exists     | Update the payment record; the webhook won the race     |
| `canceled` / `failed`         | Release reservations, mark failed                       |
| still `processing` after 24 h | Alert a human                                           |

The index `idx_payments_pending` is partial on exactly this predicate, so the sweep is near-instant regardless of how many completed payments exist.

**This job is the difference between "we lost an order" and "the customer never noticed."** It is the last thing to be disabled and the first thing to be tested.

---

## 8. Refunds

```
staff initiates
      │
      ▼
validate ─── cumulative refunds + this amount <= payment.amount_captured ?
      │                                             │
      │ yes                                         │ no → 422, reject
      ▼
insert refund (pending) ── then call provider with an idempotency key
      │
      ▼
provider webhook: charge.refunded
      │
      ▼
BEGIN
  refund.status = succeeded
  orders.refunded_amount += amount
  orders.payment_status = 'refunded' | 'partially_refunded'
  if restocking: inventory_movements (+qty, reason='return')
  outbox: refund.issued
COMMIT
      │
      ▼
email the customer
```

**Rules:**

- Refunds are validated against the **capture ledger**, never against a computed line-item total. The `CHECK (amount_refunded <= amount_captured)` constraint is the backstop.
- Partial refunds are tracked per line item so a two-item order can be half-returned without arithmetic by hand.
- Refunds are idempotent through the same key mechanism as payments.
- Every refund records an actor and a reason code. "Who authorised this?" must always be answerable.
- Restocking is an explicit decision at the point of refund, not an automatic side effect — returned goods are frequently damaged.

---

## 9. PCI-DSS scope

**Target: SAQ-A.** The lowest compliance tier, available only when card data is fully outsourced.

```
   ┌────────────── BROWSER ──────────────┐
   │  Our page                           │
   │  ┌───────────────────────────────┐  │
   │  │  Stripe iframe                │  │   card number typed here
   │  │  origin: js.stripe.com        │──┼─────────────────────────▶ Stripe
   │  │  We cannot read inside it.    │  │   (direct, never via us)
   │  └───────────────────────────────┘  │
   └─────────────────┬───────────────────┘
                     │  payment_method token only
                     ▼
              ┌─────────────┐
              │  Our API    │   sees: pm_xxx, pi_xxx, brand, last4
              │             │   never: PAN, CVC, expiry, magnetic data
              └─────────────┘
```

**Hard rules, enforced in code review and by automated log scanning:**

1. No endpoint accepts a field that could hold a card number. There is no such Pydantic model anywhere in the codebase.
2. No log line, error message, exception payload, or Sentry breadcrumb may contain card data. A regex scanner runs against structured log output in CI.
3. `card_brand` and `card_last4` are stored for display only, and come from the provider — never from a client request.
4. The CSP `frame-src` allowlist contains the payment provider origins and nothing else.
5. The payment page is served over TLS with HSTS.

Any proposed change that would cause a PAN to reach our origin is an automatic rejection, regardless of the convenience gained.

---

## 10. Error handling in checkout

Every one of these has a designed state in the UI. None of them may produce a blank screen, a raw error, or a silent failure.

| Failure                    | HTTP | Customer sees                                                              | Recovery                                                         |
| -------------------------- | ---- | -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Card declined              | 402  | "Your card was declined. Try another card or payment method."              | Retry inline; cart and reservation preserved                     |
| Insufficient funds         | 402  | Same message, plus wallet options surfaced                                 | Retry inline                                                     |
| 3-D Secure failed          | 402  | "Authentication failed. Please try again."                                 | Retry inline                                                     |
| Stock lost during checkout | 409  | "Sorry — the last one just sold. We've removed it from your order."        | Cart adjusted, totals recomputed, checkout continues             |
| Session expired            | 410  | "Your checkout timed out. Your cart is saved."                             | Redirect to cart, one click to restart                           |
| Discount became invalid    | 422  | "That code expired while you were checking out."                           | Removed, total updated, customer continues                       |
| Address unserviceable      | 422  | "We don't ship to that region yet."                                        | Inline on the address step                                       |
| Provider down              | 503  | "Payments are temporarily unavailable. Please try again in a few minutes." | Reservation held; optionally fail over to the secondary provider |
| Network drop mid-payment   | —    | "Confirming your payment…" with a spinner                                  | Poll the session; webhook or reconciliation resolves it          |

**The last row is the most important one.** A customer whose connection drops after submitting payment must never be told "something went wrong" — their payment may well have succeeded. The page polls, and the truth arrives from the server.

---

## 11. Test matrix

No part of this subsystem ships without every row below passing.

### Unit

- [ ] Every legal state transition; every illegal one rejected
- [ ] Total assembly: subtotal, discount, shipping, tax, rounding
- [ ] Property-based: totals never negative, discount never exceeds subtotal, rounding never invents or loses a cent
- [ ] Refund validation against capture ceiling, including cumulative partials

### Integration

- [ ] Full checkout → intent → webhook → order
- [ ] Idempotency: same key twice returns an identical response, executes once
- [ ] Idempotency: same key, different body → 422
- [ ] Idempotency: concurrent requests with the same key → one executes, one gets 409
- [ ] Webhook with an invalid signature → 400, nothing written
- [ ] Duplicate webhook → 200, one order
- [ ] Out-of-order webhooks (`failed` after `succeeded`) → correct final state
- [ ] Reconciliation creates the order when no webhook arrived
- [ ] Reservation expiry returns stock
- [ ] Price change between cart and payment → total recomputed, customer informed

### Concurrency — _the suite that matters most_

- [ ] N simultaneous checkouts, 1 unit of stock, N ∈ {2, 10, 100} → exactly 1 order, N−1 clean `409 out of stock`
- [ ] Simultaneous discount redemptions against `max_redemptions = 1` → exactly 1 succeeds
- [ ] Simultaneous cart mutations → no lost updates
- [ ] Simultaneous refunds totalling more than the capture → the second is rejected

### End-to-end (Playwright, real Stripe test mode)

- [ ] Successful purchase with `4242 4242 4242 4242`
- [ ] 3-D Secure challenge with `4000 0025 0000 3155`
- [ ] Decline with `4000 0000 0000 9995`, then a successful retry
- [ ] Guest checkout, full journey
- [ ] Discount code applied end to end
- [ ] Apple Pay / Google Pay express path

### Load (k6)

- [ ] 500 concurrent checkouts: p95 under 500 ms, **zero oversells**, zero duplicate charges

---

## 12. Launch checklist

- [ ] Stripe account activated; live keys in the production secret manager only
- [ ] Live webhook endpoint registered, signing secret configured, a test event delivered and processed
- [ ] Webhook endpoint reachable over HTTPS with a valid certificate
- [ ] Reconciliation job scheduled and verified running in production
- [ ] Reservation sweeper scheduled and verified
- [ ] Alerting live: payment failure rate > 5%, dead-letter queue non-empty, zero orders in 30 minutes during business hours
- [ ] Refund flow tested against a real live transaction, then reversed
- [ ] Tax rates verified against the actual business obligation — **confirmed with an accountant, not guessed**
- [ ] Shipping zones and rates verified against real carrier pricing
- [ ] Refund and returns policy published and linked from checkout
- [ ] PCI SAQ-A self-assessment completed and filed
- [ ] Log scanner confirms no card data in any production log stream
- [ ] Runbook written: what to do when payments start failing at 2am
