"""Checkout and payments end to end (PLANNING.md Phase 8, PAYMENTS-AND-CHECKOUT.md §11).

Against real Postgres and Redis, with the production Stripe adapter talking to
a fake Stripe (checkout_support.py). Orders are only ever created the way
production creates them: a signed webhook, processed by the worker's
processor — or reconciliation, when no webhook came.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from typing import Any

import pytest
from fastapi import FastAPI

from tests.integration.catalog_support import problem, product, sql, variant
from tests.integration.checkout_support import (
    US_ADDRESS,
    FakeStripe,
    deliver,
    key,
    pay,
    process_events,
    providers_for,
    reconcile,
    start,
    sweep,
    to_payment,
)
from tests.integration.conftest import Browser, drain, sign_in_as
from tests.integration.test_cart import add, discount, shipping_and_tax
from velo.core.email import InMemoryMailer
from velo.domains.payments.registry import PaymentProviders

pytestmark = pytest.mark.integration

NewBrowser = Callable[[], AbstractAsyncContextManager[Browser]]
PRICE = 5000
# CA: $50.00 + $5.99 standard shipping + 7.25% tax on $50.00 ($3.625, half up).
EXPECTED_TOTAL = 5000 + 599 + 363


@pytest.fixture
def stripe() -> FakeStripe:
    return FakeStripe()


@pytest.fixture
async def providers(live_app: FastAPI, stripe: FakeStripe) -> PaymentProviders:
    from velo.api.deps import get_payment_providers

    configured = providers_for(stripe)
    live_app.dependency_overrides[get_payment_providers] = lambda: configured
    return configured


@pytest.fixture
async def lamp(admin: Browser) -> dict[str, Any]:
    await shipping_and_tax()
    made = await product(admin, "Desk Lamp", variants=[variant(price=PRICE, stock=3, sku="LAMP-1")])
    return dict(made["variants"][0])


async def stock(variant_id: str) -> tuple[int, int]:
    on_hand = await sql(
        "SELECT quantity_on_hand FROM inventory_items WHERE variant_id = :v", v=variant_id
    )
    reserved = await sql(
        "SELECT quantity_reserved FROM inventory_items WHERE variant_id = :v", v=variant_id
    )
    return int(on_hand), int(reserved)


async def checkout_ready(browser: Browser, lamp: dict[str, Any], quantity: int = 1) -> str:
    """A cart with the lamp, a checkout, an address and a shipping rate. Returns its id."""
    assert (await add(browser, lamp["id"], quantity)).status_code == 200
    response = await start(browser)
    assert response.status_code == 201, response.text
    checkout_id = str(response.json()["id"])
    await to_payment(browser, checkout_id)
    return checkout_id


async def paid(
    browser: Browser, stripe: FakeStripe, providers: PaymentProviders, checkout_id: str
) -> dict[str, Any]:
    """Pay, have Stripe say it succeeded, deliver and process the webhook."""
    response = await pay(browser, checkout_id)
    assert response.status_code == 201, response.text
    intent_id = response.json()["client_secret"].split("_secret")[0]
    stripe.succeed(intent_id)
    assert (
        await deliver(browser, stripe.event("payment_intent.succeeded", intent_id))
    ).status_code == 200
    await process_events(providers)
    return dict((await browser.get(f"/api/v1/checkout/{checkout_id}")).json())


# ── The happy path ────────────────────────────────────────────────────────────


async def test_a_guest_buys_a_lamp_end_to_end(
    browser: Browser, stripe: FakeStripe, providers: PaymentProviders, lamp: dict[str, Any]
) -> None:
    await add(browser, lamp["id"], 1)

    created = await start(browser)
    assert created.status_code == 201, created.text
    body = created.json()
    checkout_id = body["id"]
    set_cookie = created.headers["set-cookie"]
    assert "velo_checkout=" in set_cookie and "HttpOnly" in set_cookie
    assert body["status"] == "initiated"
    assert body["totals"]["subtotal"]["amount"] == PRICE
    assert body["totals"]["shipping"] is None  # unknown until there is an address
    assert await stock(lamp["id"]) == (3, 1)  # reserved, not yet sold

    ready = await to_payment(browser, checkout_id)
    assert ready["status"] == "shipping_set"
    assert ready["shipping_address"]["country_code"] == "US"
    assert ready["shipping_address"]["region"] == "CA"  # normalised
    assert ready["totals"]["total"]["amount"] == EXPECTED_TOTAL

    intent = await pay(browser, checkout_id)
    assert intent.status_code == 201, intent.text
    assert intent.json()["amount"] == {"amount": EXPECTED_TOTAL, "currency": "USD"}
    assert intent.json()["publishable_key"] == "pk_test_fake"
    intent_id = stripe.only_intent()
    # The amount Stripe was asked for is the server's figure.
    assert stripe.intents[intent_id]["amount"] == EXPECTED_TOTAL
    assert stripe.intents[intent_id]["metadata"]["payment_id"] == intent.json()["payment_id"]
    pending = (await browser.get(f"/api/v1/checkout/{checkout_id}")).json()
    assert pending["status"] == "payment_pending" and pending["order_number"] is None

    stripe.succeed(intent_id, last4="4242")
    delivered = await deliver(browser, stripe.event("payment_intent.succeeded", intent_id))
    assert delivered.status_code == 200 and delivered.json() == {"received": True}
    assert await sql("SELECT count(*) FROM orders") == 0  # acknowledged; not yet processed
    assert await process_events(providers) == {"processed": 1}

    done = (await browser.get(f"/api/v1/checkout/{checkout_id}")).json()
    assert done["status"] == "confirmed"
    assert done["order_number"].startswith("VLO-")
    assert await sql("SELECT total_amount FROM orders") == EXPECTED_TOTAL
    assert await sql("SELECT status || '/' || payment_status FROM orders") == "paid/paid"
    assert await sql("SELECT shipping_address->>'city' FROM orders") == "San Francisco"
    assert await sql(
        "SELECT sku || ':' || quantity || ':' || unit_price_amount FROM order_items"
    ) == (f"LAMP-1:1:{PRICE}")
    assert await sql("SELECT tax_amount FROM order_items") == 363
    # Stock: sold, and the reservation gone. The ledger has the sale.
    assert await stock(lamp["id"]) == (2, 0)
    assert await sql("SELECT quantity_delta FROM inventory_movements WHERE reason = 'sale'") == -1
    assert await sql("SELECT status FROM inventory_reservations") == "committed"
    # The payment: captured, display-only card details from Stripe.
    assert await sql("SELECT status FROM payments") == "succeeded"
    assert await sql("SELECT amount_captured FROM payments") == EXPECTED_TOTAL
    assert await sql("SELECT card_brand || ' ' || card_last4 FROM payments") == "visa 4242"
    assert await sql("SELECT order_id IS NOT NULL FROM payments")
    # The cart is emptied of what was bought; the confirmation email is queued.
    assert (await browser.get("/api/v1/cart")).json()["items"] == []
    assert await sql("SELECT count(*) FROM outbox_events WHERE event_type = 'order.created'") == 1


async def test_the_customer_is_emailed_a_confirmation_once_the_order_exists(
    browser: Browser,
    stripe: FakeStripe,
    providers: PaymentProviders,
    lamp: dict[str, Any],
    worker_ctx: dict[str, Any],
    mailer: InMemoryMailer,
) -> None:
    checkout_id = await checkout_ready(browser, lamp)
    done = await paid(browser, stripe, providers, checkout_id)

    await drain(worker_ctx)

    confirmations = [m for m in mailer.outbox if m.to == "ada@example.com"]
    assert len(confirmations) == 1
    assert done["order_number"] in confirmations[0].subject
    assert "1 x Desk Lamp" in confirmations[0].text
    assert "USD 59.62" in confirmations[0].text


async def test_a_signed_in_customer_checks_out_with_their_account_email(
    new_browser: NewBrowser, stripe: FakeStripe, providers: PaymentProviders, lamp: dict[str, Any]
) -> None:
    async with new_browser() as browser:
        await sign_in_as(browser, "grace@example.com")
        checkout_id = await checkout_ready(browser, lamp)
        done = await paid(browser, stripe, providers, checkout_id)

    assert done["email"] == "grace@example.com"
    assert await sql("SELECT user_id IS NOT NULL FROM orders")


async def test_order_lines_are_snapshots_that_catalog_edits_cannot_change(
    browser: Browser, stripe: FakeStripe, providers: PaymentProviders, lamp: dict[str, Any]
) -> None:
    checkout_id = await checkout_ready(browser, lamp)
    await paid(browser, stripe, providers, checkout_id)

    await sql(
        "UPDATE product_variants SET price_amount = 1, sku = 'RENAMED' WHERE id = :v", v=lamp["id"]
    )
    await sql("UPDATE products SET title = 'Renamed'")

    assert await sql("SELECT product_title || '/' || sku FROM order_items") == "Desk Lamp/LAMP-1"
    assert await sql("SELECT unit_price_amount FROM order_items") == PRICE


# ── Nothing about the price comes from the client ────────────────────────────


@pytest.mark.parametrize(
    ("path", "body"),
    [
        ("", {"email": "a@example.com", "total": 1}),
        ("/{id}/address", {"shipping_address": {**US_ADDRESS, "price": 1}}),
        ("/{id}/shipping", {"shipping_rate_id": None, "amount": 1}),
    ],
)
async def test_a_price_in_any_checkout_request_is_refused(
    browser: Browser, providers: PaymentProviders, lamp: dict[str, Any], path: str, body: Any
) -> None:
    await add(browser, lamp["id"])
    checkout_id = (await start(browser)).json()["id"]
    method = browser.post if path == "" else browser.patch

    response = await method(
        f"/api/v1/checkout{path.format(id=checkout_id)}", json=body, headers=key()
    )

    assert response.status_code == 422


async def test_the_total_is_recomputed_from_the_database_before_the_provider_is_called(
    browser: Browser, stripe: FakeStripe, providers: PaymentProviders, lamp: dict[str, Any]
) -> None:
    checkout_id = await checkout_ready(browser, lamp)
    await sql("UPDATE product_variants SET price_amount = 6000 WHERE id = :v", v=lamp["id"])

    changed = await pay(browser, checkout_id)

    assert changed.status_code == 409 and problem(changed) == "price-changed"
    assert stripe.intents == {}  # nothing was charged
    repriced = (await browser.get(f"/api/v1/checkout/{checkout_id}")).json()
    assert repriced["items"][0]["unit_price"]["amount"] == 6000
    expected = 6000 + 599 + 435  # 7.25% of $60.00
    assert repriced["totals"]["total"]["amount"] == expected
    # The customer has seen the new total; paying now charges exactly that.
    retried = await pay(browser, checkout_id)
    assert retried.status_code == 201, retried.text
    assert stripe.intents[stripe.only_intent()]["amount"] == expected


# ── Ownership ─────────────────────────────────────────────────────────────────


async def test_another_browser_cannot_see_or_touch_the_checkout(
    browser: Browser, new_browser: NewBrowser, providers: PaymentProviders, lamp: dict[str, Any]
) -> None:
    await add(browser, lamp["id"])
    checkout_id = (await start(browser)).json()["id"]

    async with new_browser() as stranger:
        assert (await stranger.get(f"/api/v1/checkout/{checkout_id}")).status_code == 404
        response = await stranger.patch(
            f"/api/v1/checkout/{checkout_id}/address", json={"shipping_address": US_ADDRESS}
        )
        assert response.status_code == 404
        assert (await pay(stranger, checkout_id)).status_code == 404


# ── Stock ─────────────────────────────────────────────────────────────────────


async def test_checkout_refuses_what_is_not_in_stock(
    browser: Browser, new_browser: NewBrowser, providers: PaymentProviders, lamp: dict[str, Any]
) -> None:
    await add(browser, lamp["id"], 2)
    assert (await start(browser)).status_code == 201  # 2 of 3 reserved
    async with new_browser() as other:
        await add(other, lamp["id"], 1)
        await sql(
            "UPDATE inventory_items SET quantity_on_hand = 2 WHERE variant_id = :v", v=lamp["id"]
        )

        refused = await start(other)

    assert refused.status_code == 409 and problem(refused) == "out-of-stock"
    assert refused.json()["errors"][0]["field"] == f"items.{lamp['id']}"
    assert refused.json()["detail"] == "Sorry — the last one just sold."
    assert await stock(lamp["id"]) == (2, 2)


async def test_an_expired_checkout_returns_its_stock(
    browser: Browser, providers: PaymentProviders, lamp: dict[str, Any]
) -> None:
    await add(browser, lamp["id"], 2)
    checkout_id = (await start(browser)).json()["id"]
    assert await stock(lamp["id"]) == (3, 2)
    await sql("UPDATE checkout_sessions SET expires_at = now() - interval '1 minute'")
    await sql("UPDATE inventory_reservations SET expires_at = now() - interval '1 minute'")

    assert (await sweep())["expired"] == 1

    assert await stock(lamp["id"]) == (3, 0)
    assert await sql("SELECT status FROM inventory_reservations") == "expired"
    body = (await browser.get(f"/api/v1/checkout/{checkout_id}")).json()
    assert body["status"] == "expired"
    gone = await browser.patch(
        f"/api/v1/checkout/{checkout_id}/address", json={"shipping_address": US_ADDRESS}
    )
    assert gone.status_code == 410 and problem(gone) == "checkout-expired"
    assert (await browser.get("/api/v1/cart")).json()["item_count"] == 2  # the cart is saved


async def test_touching_a_timed_out_checkout_expires_it_without_the_sweeper(
    browser: Browser, providers: PaymentProviders, lamp: dict[str, Any]
) -> None:
    await add(browser, lamp["id"])
    checkout_id = (await start(browser)).json()["id"]
    await sql("UPDATE checkout_sessions SET expires_at = now() - interval '1 second'")

    response = await browser.patch(
        f"/api/v1/checkout/{checkout_id}/address", json={"shipping_address": US_ADDRESS}
    )

    assert response.status_code == 410
    assert await stock(lamp["id"]) == (3, 0)


async def test_starting_again_retires_the_previous_checkout_of_the_same_cart(
    browser: Browser, providers: PaymentProviders, lamp: dict[str, Any]
) -> None:
    await add(browser, lamp["id"], 2)
    first = (await start(browser)).json()["id"]
    second = (await start(browser)).json()["id"]

    assert first != second
    assert await sql("SELECT status FROM checkout_sessions WHERE id = :i", i=first) == "abandoned"
    assert await stock(lamp["id"]) == (3, 2)  # held once, not twice


async def test_abandoning_releases_the_stock(
    browser: Browser, providers: PaymentProviders, lamp: dict[str, Any]
) -> None:
    await add(browser, lamp["id"])
    checkout_id = (await start(browser)).json()["id"]

    response = await browser.post(f"/api/v1/checkout/{checkout_id}/abandon")

    assert response.status_code == 200 and response.json()["status"] == "abandoned"
    assert await stock(lamp["id"]) == (3, 0)


# ── Steps and the state machine ───────────────────────────────────────────────


async def test_steps_out_of_order_are_refused(
    browser: Browser, providers: PaymentProviders, lamp: dict[str, Any]
) -> None:
    await add(browser, lamp["id"])
    checkout_id = (await start(browser)).json()["id"]

    early = await pay(browser, checkout_id)
    assert early.status_code == 409 and problem(early) == "checkout-state"
    no_address = await browser.patch(
        f"/api/v1/checkout/{checkout_id}/shipping", json={"shipping_rate_id": None}
    )
    assert no_address.status_code == 409


async def test_a_region_we_do_not_ship_to_is_refused_on_the_address_step(
    browser: Browser, providers: PaymentProviders, lamp: dict[str, Any]
) -> None:
    await add(browser, lamp["id"])
    checkout_id = (await start(browser)).json()["id"]

    response = await browser.patch(
        f"/api/v1/checkout/{checkout_id}/address",
        json={"shipping_address": {**US_ADDRESS, "country_code": "FR", "region": None}},
    )

    assert response.status_code == 422 and problem(response) == "address-unserviceable"


async def test_changing_the_address_after_choosing_shipping_is_allowed(
    browser: Browser, providers: PaymentProviders, lamp: dict[str, Any]
) -> None:
    checkout_id = await checkout_ready(browser, lamp)

    response = await browser.patch(
        f"/api/v1/checkout/{checkout_id}/address",
        json={"shipping_address": {**US_ADDRESS, "region": "NY", "postal_code": "10001"}},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "address_set"
    assert body["totals"]["tax"]["amount"] == 0  # no NY rate configured


async def test_a_guest_must_give_an_email(
    browser: Browser, providers: PaymentProviders, lamp: dict[str, Any]
) -> None:
    await add(browser, lamp["id"])

    response = await start(browser, email=None)

    assert response.status_code == 422
    assert response.json()["errors"][0]["field"] == "email"


async def test_an_empty_cart_cannot_check_out(
    browser: Browser, providers: PaymentProviders
) -> None:
    response = await start(browser)

    assert response.status_code == 422 and problem(response) == "cart-empty"


# ── Idempotency ───────────────────────────────────────────────────────────────


async def test_the_same_key_twice_replays_the_response_and_runs_once(
    browser: Browser, stripe: FakeStripe, providers: PaymentProviders, lamp: dict[str, Any]
) -> None:
    checkout_id = await checkout_ready(browser, lamp)
    headers = key()

    first = await pay(browser, checkout_id, headers)
    second = await pay(browser, checkout_id, headers)

    assert first.status_code == second.status_code == 201
    assert first.json() == second.json()
    assert second.headers["Idempotency-Replayed"] == "true"
    assert "Idempotency-Replayed" not in first.headers
    assert len(stripe.intents) == 1
    assert await sql("SELECT count(*) FROM payments") == 1


async def test_a_replayed_checkout_creation_is_the_same_checkout(
    browser: Browser, providers: PaymentProviders, lamp: dict[str, Any]
) -> None:
    await add(browser, lamp["id"])
    headers = key()

    first = await start(browser, headers=headers)
    second = await start(browser, headers=headers)

    assert first.json()["id"] == second.json()["id"]
    assert await sql("SELECT count(*) FROM checkout_sessions") == 1
    assert await stock(lamp["id"]) == (3, 1)


async def test_the_same_key_with_a_different_body_is_refused(
    browser: Browser, providers: PaymentProviders, lamp: dict[str, Any]
) -> None:
    await add(browser, lamp["id"])
    headers = key()
    await start(browser, email="one@example.com", headers=headers)

    response = await start(browser, email="two@example.com", headers=headers)

    assert response.status_code == 422 and problem(response) == "idempotency-key-reused"


async def test_a_money_moving_request_without_a_key_is_refused(
    browser: Browser, providers: PaymentProviders, lamp: dict[str, Any]
) -> None:
    await add(browser, lamp["id"])

    response = await browser.post("/api/v1/checkout", json={"email": "a@example.com"})

    assert response.status_code == 400 and problem(response) == "idempotency-key-required"
    assert await sql("SELECT count(*) FROM checkout_sessions") == 0


async def test_concurrent_requests_with_one_key_execute_once(
    browser: Browser, stripe: FakeStripe, providers: PaymentProviders, lamp: dict[str, Any]
) -> None:
    checkout_id = await checkout_ready(browser, lamp)
    headers = key()
    stripe.delay = 0.5  # hold the first request inside the provider call

    first, second = await asyncio.gather(
        pay(browser, checkout_id, headers), pay(browser, checkout_id, headers)
    )

    statuses = sorted([first.status_code, second.status_code])
    assert statuses == [201, 409]
    loser = first if first.status_code == 409 else second
    assert problem(loser) == "request-in-progress"
    assert len(stripe.intents) == 1
    # Once it has finished, the same key replays the result.
    stripe.delay = 0
    assert (await pay(browser, checkout_id, headers)).headers["Idempotency-Replayed"] == "true"


async def test_a_failed_request_frees_its_key_for_a_retry(
    browser: Browser, stripe: FakeStripe, providers: PaymentProviders, lamp: dict[str, Any]
) -> None:
    checkout_id = await checkout_ready(browser, lamp)
    headers = key()
    stripe.down = True

    down = await pay(browser, checkout_id, headers)
    assert down.status_code == 503 and problem(down) == "payments-unavailable"
    assert await stock(lamp["id"]) == (3, 1)  # the reservation is held
    assert (await browser.get(f"/api/v1/checkout/{checkout_id}")).json()["status"] == "failed"

    stripe.down = False
    retried = await pay(browser, checkout_id, headers)
    assert retried.status_code == 201, retried.text


# ── Webhooks ──────────────────────────────────────────────────────────────────


async def test_a_webhook_with_a_bad_signature_is_refused_and_nothing_is_written(
    browser: Browser, stripe: FakeStripe, providers: PaymentProviders, lamp: dict[str, Any]
) -> None:
    checkout_id = await checkout_ready(browser, lamp)
    await pay(browser, checkout_id)
    intent_id = stripe.only_intent()
    stripe.succeed(intent_id)
    body, signature = stripe.event("payment_intent.succeeded", intent_id)
    forged = body.replace(b'"succeeded"', b'"succeeded" ')  # one byte changed

    for payload, header in [(forged, signature), (body, "t=1,v1=00"), (body, "")]:
        response = await deliver(browser, (payload, header))
        assert response.status_code == 400 and problem(response) == "invalid-signature"

    assert await sql("SELECT count(*) FROM payment_events") == 0
    assert await sql("SELECT count(*) FROM orders") == 0


async def test_a_duplicate_webhook_is_acknowledged_and_creates_one_order(
    browser: Browser, stripe: FakeStripe, providers: PaymentProviders, lamp: dict[str, Any]
) -> None:
    checkout_id = await checkout_ready(browser, lamp)
    await pay(browser, checkout_id)
    intent_id = stripe.only_intent()
    stripe.succeed(intent_id)
    delivery = stripe.event("payment_intent.succeeded", intent_id, event_id="evt_same")

    responses = [await deliver(browser, delivery) for _ in range(3)]
    await process_events(providers)
    # A different event id for the same success (Stripe retries do reuse ids;
    # this is belt and braces): still one order.
    await deliver(browser, stripe.event("payment_intent.succeeded", intent_id))
    await process_events(providers)

    assert [r.status_code for r in responses] == [200, 200, 200]
    assert await sql("SELECT count(*) FROM payment_events") == 2
    assert await sql("SELECT count(*) FROM orders") == 1
    assert await stock(lamp["id"]) == (2, 0)


async def test_failed_after_succeeded_does_not_undo_the_order(
    browser: Browser, stripe: FakeStripe, providers: PaymentProviders, lamp: dict[str, Any]
) -> None:
    checkout_id = await checkout_ready(browser, lamp)
    await pay(browser, checkout_id)
    intent_id = stripe.only_intent()
    stripe.decline(intent_id)
    failed = stripe.event("payment_intent.payment_failed", intent_id)
    stripe.succeed(intent_id)
    succeeded = stripe.event("payment_intent.succeeded", intent_id)

    await deliver(browser, succeeded)
    await process_events(providers)
    await deliver(browser, failed)  # arrives late
    await process_events(providers)

    assert await sql("SELECT status FROM payments") == "succeeded"
    assert await sql("SELECT status FROM orders") == "paid"
    assert (await browser.get(f"/api/v1/checkout/{checkout_id}")).json()["status"] == "confirmed"


async def test_a_decline_then_a_good_card_on_the_same_intent_creates_the_order(
    browser: Browser, stripe: FakeStripe, providers: PaymentProviders, lamp: dict[str, Any]
) -> None:
    checkout_id = await checkout_ready(browser, lamp)
    await pay(browser, checkout_id)
    intent_id = stripe.only_intent()

    stripe.decline(intent_id)
    await deliver(browser, stripe.event("payment_intent.payment_failed", intent_id))
    await process_events(providers)
    declined = (await browser.get(f"/api/v1/checkout/{checkout_id}")).json()
    assert declined["status"] == "failed"
    assert declined["payment"] == {
        "status": "failed",
        "failure_message": "Your card has insufficient funds.",
    }
    assert await stock(lamp["id"]) == (3, 1)  # held while the customer retries
    assert await sql("SELECT count(*) FROM outbox_events WHERE event_type = 'payment.failed'") == 1

    stripe.succeed(intent_id)
    await deliver(browser, stripe.event("payment_intent.succeeded", intent_id))
    await process_events(providers)

    assert (await browser.get(f"/api/v1/checkout/{checkout_id}")).json()["status"] == "confirmed"
    assert await sql("SELECT count(*) FROM orders") == 1


async def test_after_a_decline_a_new_payment_attempt_can_be_made(
    browser: Browser, stripe: FakeStripe, providers: PaymentProviders, lamp: dict[str, Any]
) -> None:
    checkout_id = await checkout_ready(browser, lamp)
    await pay(browser, checkout_id)
    first = stripe.only_intent()
    stripe.decline(first)
    await deliver(browser, stripe.event("payment_intent.payment_failed", first))
    await process_events(providers)

    retry = await pay(browser, checkout_id)

    assert retry.status_code == 201, retry.text
    assert len(stripe.intents) == 2
    second = retry.json()["client_secret"].split("_secret")[0]
    stripe.succeed(second)
    await deliver(browser, stripe.event("payment_intent.succeeded", second))
    await process_events(providers)
    assert await sql("SELECT count(*) FROM orders") == 1


async def test_a_refund_at_the_provider_updates_the_order(
    browser: Browser, stripe: FakeStripe, providers: PaymentProviders, lamp: dict[str, Any]
) -> None:
    checkout_id = await checkout_ready(browser, lamp)
    await paid(browser, stripe, providers, checkout_id)
    intent_id = stripe.only_intent()

    refund = stripe.event("charge.refunded", intent_id, id=f"ch_{intent_id}", amount_refunded=1000)
    await deliver(browser, refund)
    await deliver(browser, refund)  # a duplicate delivery changes nothing
    await process_events(providers)

    assert await sql("SELECT refunded_amount FROM orders") == 1000
    assert await sql("SELECT payment_status FROM orders") == "partially_refunded"
    assert await sql("SELECT amount_refunded FROM payments") == 1000
    assert await sql("SELECT count(*) FROM refunds") == 1
    assert await sql("SELECT count(*) FROM order_events WHERE event_type = 'refunded'") == 1


async def test_a_dispute_flags_the_order(
    browser: Browser, stripe: FakeStripe, providers: PaymentProviders, lamp: dict[str, Any]
) -> None:
    checkout_id = await checkout_ready(browser, lamp)
    await paid(browser, stripe, providers, checkout_id)
    intent_id = stripe.only_intent()

    await deliver(
        browser,
        stripe.event(
            "charge.dispute.created",
            intent_id,
            id="dp_1",
            amount=EXPECTED_TOTAL,
            reason="fraudulent",
            status="needs_response",
        ),
    )
    await process_events(providers)

    assert await sql("SELECT (metadata->'dispute'->>'open')::boolean FROM orders")
    assert (
        await sql("SELECT count(*) FROM outbox_events WHERE event_type = 'order.dispute_opened'")
        == 1
    )


async def test_an_event_that_keeps_failing_is_dead_lettered_and_can_be_replayed(
    browser: Browser, stripe: FakeStripe, providers: PaymentProviders, lamp: dict[str, Any]
) -> None:
    checkout_id = await checkout_ready(browser, lamp)
    await pay(browser, checkout_id)
    intent_id = stripe.only_intent()
    stripe.succeed(intent_id)
    # A bug: the event names an intent we cannot match to a payment. Every attempt fails.
    stripe.intents[intent_id]["metadata"] = {}
    await sql("UPDATE payments SET provider_intent_id = 'pi_other'")
    await deliver(browser, stripe.event("payment_intent.succeeded", intent_id))

    for _ in range(5):
        await process_events(providers)
        await sql("UPDATE payment_events SET next_attempt_at = now()")  # skip the backoff

    assert await sql("SELECT dead_lettered_at IS NOT NULL FROM payment_events")
    assert await sql("SELECT attempts FROM payment_events") == 5
    assert "no payment for intent" in await sql("SELECT processing_error FROM payment_events")
    assert (
        await sql(
            "SELECT count(*) FROM outbox_events WHERE event_type = 'payment_event.dead_lettered'"
        )
        == 1
    )
    assert await process_events(providers) == {}  # dead: no longer retried

    # The bug is fixed; the replay tool gives the event a fresh start.
    await sql("UPDATE payments SET provider_intent_id = :i", i=intent_id)
    await sql(
        "UPDATE payment_events SET attempts = 0, dead_lettered_at = NULL, next_attempt_at = NULL"
    )
    assert await process_events(providers) == {"processed": 1}
    assert await sql("SELECT count(*) FROM orders") == 1


# ── Reconciliation: the safety net ────────────────────────────────────────────


async def test_reconciliation_creates_the_order_when_no_webhook_arrives(
    browser: Browser, stripe: FakeStripe, providers: PaymentProviders, lamp: dict[str, Any]
) -> None:
    checkout_id = await checkout_ready(browser, lamp)
    await pay(browser, checkout_id)
    stripe.succeed(stripe.only_intent())  # paid — and the webhook is lost

    assert await reconcile(providers) == {}  # too recent: the webhook may still come
    await sql("UPDATE payments SET created_at = now() - interval '31 minutes'")
    assert await reconcile(providers) == {"recovered": 1}

    body = (await browser.get(f"/api/v1/checkout/{checkout_id}")).json()
    assert body["status"] == "confirmed" and body["order_number"]
    assert await stock(lamp["id"]) == (2, 0)
    # The webhook turns up after all: nothing changes.
    await deliver(browser, stripe.event("payment_intent.succeeded", stripe.only_intent()))
    await process_events(providers)
    assert await sql("SELECT count(*) FROM orders") == 1


async def test_reconciliation_cancels_an_intent_nobody_finished_paying(
    browser: Browser, stripe: FakeStripe, providers: PaymentProviders, lamp: dict[str, Any]
) -> None:
    checkout_id = await checkout_ready(browser, lamp)
    await pay(browser, checkout_id)
    await sql("UPDATE payments SET created_at = now() - interval '31 minutes'")
    await sql("UPDATE checkout_sessions SET expires_at = now() - interval '1 minute'")

    assert await reconcile(providers) == {"cancelled": 1}

    assert stripe.intents[stripe.only_intent()]["status"] == "canceled"
    assert await sql("SELECT status FROM payments") == "cancelled"
    assert (await browser.get(f"/api/v1/checkout/{checkout_id}")).json()["status"] == "expired"
    assert await stock(lamp["id"]) == (3, 0)


async def test_reconciliation_cancels_a_payment_that_never_reached_the_provider(
    browser: Browser, stripe: FakeStripe, providers: PaymentProviders, lamp: dict[str, Any]
) -> None:
    checkout_id = await checkout_ready(browser, lamp)
    await pay(browser, checkout_id)
    # As if the API died after writing the payment, before storing the intent.
    await sql(
        "UPDATE payments SET provider_intent_id = NULL, created_at = now() - interval '31 minutes'"
    )

    assert await reconcile(providers) == {"cancelled": 1}
    assert await stock(lamp["id"]) == (3, 0)


async def test_a_payment_that_settles_after_its_checkout_expired_still_becomes_an_order(
    browser: Browser, stripe: FakeStripe, providers: PaymentProviders, lamp: dict[str, Any]
) -> None:
    checkout_id = await checkout_ready(browser, lamp)
    await pay(browser, checkout_id)
    intent_id = stripe.only_intent()
    # The checkout ended and its stock went back...
    await sql("UPDATE checkout_sessions SET status = 'expired'")
    await sql("UPDATE inventory_items SET quantity_reserved = 0")
    await sql("UPDATE inventory_reservations SET status = 'expired'")
    # ...and then the money arrived.
    stripe.succeed(intent_id)
    await deliver(browser, stripe.event("payment_intent.succeeded", intent_id))
    await process_events(providers)

    assert await sql("SELECT count(*) FROM orders") == 1
    assert await stock(lamp["id"]) == (2, 0)  # taken from free stock, which there was


# ── Discounts ─────────────────────────────────────────────────────────────────


async def test_a_limited_code_is_held_by_the_first_payment(
    new_browser: NewBrowser, stripe: FakeStripe, providers: PaymentProviders, lamp: dict[str, Any]
) -> None:
    await discount(code="ONCE", type="percentage", value=10, max_redemptions=1)
    async with new_browser() as first, new_browser() as second:
        checkouts = []
        for browser in (first, second):
            await add(browser, lamp["id"])
            applied = await browser.post("/api/v1/cart/discount", json={"code": "ONCE"})
            assert applied.status_code == 200, applied.text
            response = await start(browser)
            assert response.status_code == 201, response.text
            assert response.json()["discounts"][0]["code"] == "ONCE"
            checkouts.append(response.json()["id"])
            await to_payment(browser, checkouts[-1])

        winner = await pay(first, checkouts[0])
        loser = await pay(second, checkouts[1])

        assert winner.status_code == 201
        assert loser.status_code == 422 and problem(loser) == "discount-expired"
        repriced = (await second.get(f"/api/v1/checkout/{checkouts[1]}")).json()
        assert repriced["discounts"] == []
        assert repriced["totals"]["total"]["amount"] == EXPECTED_TOTAL

        intent_id = stripe.only_intent()
        stripe.succeed(intent_id)
        await deliver(first, stripe.event("payment_intent.succeeded", intent_id))
        await process_events(providers)

    assert await sql("SELECT times_redeemed FROM discounts") == 1
    assert await sql("SELECT count(*) FROM discount_redemptions") == 1
    assert await sql("SELECT discount_code FROM orders") == "ONCE"


async def test_a_first_order_code_is_checked_against_a_guests_email_at_checkout(
    browser: Browser,
    new_browser: NewBrowser,
    stripe: FakeStripe,
    providers: PaymentProviders,
    lamp: dict[str, Any],
) -> None:
    await discount(code="WELCOME", type="percentage", value=10, first_order_only=True)
    checkout_id = await checkout_ready(browser, lamp)
    await paid(browser, stripe, providers, checkout_id)  # ada@example.com has ordered once

    async with new_browser() as again:
        await add(again, lamp["id"])
        await again.post("/api/v1/cart/discount", json={"code": "WELCOME"})
        body = (await start(again)).json()  # the same email

    assert body["discounts"] == []
    assert "discount_not_applied" in [w["code"] for w in body["warnings"]]
