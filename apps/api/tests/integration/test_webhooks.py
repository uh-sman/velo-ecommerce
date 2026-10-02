"""The webhook suite (PLANNING.md Phase 13): what an attacker or a flaky network can send.

Duplicates and a late failure after success are in ``test_checkout.py``; this
file adds the rest — replayed deliveries, signed bodies that are not events,
events out of order, events we do not handle, and providers not configured.
Every case ends the same way: nothing is written that should not be, and
no order is created or undone by anything but a genuine success.
"""

from __future__ import annotations

import json
import time
from typing import Any

import pytest
from fastapi import FastAPI

from tests.integration.catalog_support import problem, product, sql, variant
from tests.integration.checkout_support import (
    WEBHOOK_SECRET,
    FakeStripe,
    deliver,
    pay,
    process_events,
    providers_for,
    start,
    to_payment,
)
from tests.integration.conftest import Browser
from tests.integration.test_cart import add, shipping_and_tax
from velo.domains.payments.registry import PaymentProviders
from velo.domains.payments.stripe import SIGNATURE_TOLERANCE_SECONDS, sign

pytestmark = pytest.mark.integration


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
async def paying(browser: Browser, admin: Browser, stripe: FakeStripe) -> tuple[str, str]:
    """A checkout with a payment intent at the fake Stripe. Returns (checkout id, intent id)."""
    await shipping_and_tax()
    made = await product(admin, "Kettle", variants=[variant(price=5000, stock=3, sku="KETTLE")])
    assert (await add(browser, made["variants"][0]["id"])).status_code == 200
    checkout_id = (await start(browser)).json()["id"]
    await to_payment(browser, checkout_id)
    assert (await pay(browser, checkout_id)).status_code == 201
    return checkout_id, stripe.only_intent()


def signed(body: bytes, *, at: int | None = None) -> tuple[bytes, str]:
    return body, sign(body, WEBHOOK_SECRET, at if at is not None else int(time.time()))


def event(event_type: str, obj: dict[str, Any], event_id: str = "evt_x") -> bytes:
    return json.dumps(
        {"id": event_id, "object": "event", "type": event_type, "data": {"object": obj}}
    ).encode()


# ── Replay ────────────────────────────────────────────────────────────────────


async def test_a_captured_delivery_replayed_later_is_refused(
    browser: Browser, stripe: FakeStripe, providers: PaymentProviders, paying: tuple[str, str]
) -> None:
    """The timestamp is inside the signature: an old delivery cannot be made fresh."""
    _, intent_id = paying
    stripe.succeed(intent_id)
    body, _ = stripe.event("payment_intent.succeeded", intent_id)
    stale = int(time.time()) - SIGNATURE_TOLERANCE_SECONDS - 60
    _, old_header = signed(body, at=stale)

    response = await deliver(browser, (body, old_header))
    assert response.status_code == 400 and problem(response) == "invalid-signature"

    # Re-dating the header without the secret breaks the signature.
    fresh_t = old_header.replace(f"t={stale}", f"t={int(time.time())}")
    response = await deliver(browser, (body, fresh_t))
    assert response.status_code == 400 and problem(response) == "invalid-signature"

    future = int(time.time()) + SIGNATURE_TOLERANCE_SECONDS + 60
    response = await deliver(browser, signed(body, at=future))
    assert response.status_code == 400

    assert await sql("SELECT count(*) FROM payment_events") == 0
    assert await sql("SELECT count(*) FROM orders") == 0


async def test_a_genuine_event_replayed_within_tolerance_is_recorded_once(
    browser: Browser, stripe: FakeStripe, providers: PaymentProviders, paying: tuple[str, str]
) -> None:
    _, intent_id = paying
    stripe.succeed(intent_id)
    delivery = stripe.event("payment_intent.succeeded", intent_id, event_id="evt_replayed")
    for _ in range(5):
        assert (await deliver(browser, delivery)).status_code == 200
    await process_events(providers)
    await process_events(providers)

    assert await sql("SELECT count(*) FROM payment_events") == 1
    assert await sql("SELECT count(*) FROM orders") == 1


# ── Malformed ─────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "body",
    [
        b"not json at all",
        b"[1, 2, 3]",
        b'{"object": "event"}',  # no id, no type
        b"",
    ],
    ids=["not-json", "not-an-object", "not-an-event", "empty"],
)
async def test_a_signed_body_that_is_not_an_event_is_refused(
    browser: Browser, providers: PaymentProviders, body: bytes
) -> None:
    response = await deliver(browser, signed(body))
    assert response.status_code == 400, response.text
    assert await sql("SELECT count(*) FROM payment_events") == 0


@pytest.mark.parametrize(
    "obj",
    [{}, {"id": "pi_1", "amount": "lots"}, {"id": "pi_1", "amount": {"nested": 1}}],
    ids=["no-id", "bad-amount", "object-amount"],
)
async def test_a_signed_event_with_a_garbled_object_is_refused_not_a_crash(
    browser: Browser, providers: PaymentProviders, obj: dict[str, Any]
) -> None:
    response = await deliver(browser, signed(event("payment_intent.succeeded", obj)))
    assert response.status_code == 400, response.text
    assert await sql("SELECT count(*) FROM payment_events") == 0
    assert await sql("SELECT count(*) FROM orders") == 0


async def test_a_signed_event_for_an_intent_we_never_made_creates_nothing(
    browser: Browser, providers: PaymentProviders
) -> None:
    """Well-formed but not ours: stored for the record, retried, never an order."""
    body = event("payment_intent.succeeded", {"id": "pi_not_ours", "status": None})
    assert (await deliver(browser, signed(body))).status_code == 200
    await process_events(providers)
    assert await sql("SELECT count(*) FROM orders") == 0
    assert await sql("SELECT count(*) FROM payment_events WHERE processed_at IS NULL") == 1


async def test_a_header_with_no_signature_or_garbage_is_refused(
    browser: Browser, providers: PaymentProviders
) -> None:
    body = event("payment_intent.succeeded", {"id": "pi_1"})
    for header in ["", "t=abc,v1=", "v1=deadbeef", "t=1", ",,,", "t=" + "9" * 40 + ",v1=00"]:
        response = await deliver(browser, (body, header))
        assert response.status_code == 400, (header, response.text)
    assert await sql("SELECT count(*) FROM payment_events") == 0


# ── Out of order ──────────────────────────────────────────────────────────────


async def test_processing_arriving_after_success_does_not_move_the_payment_back(
    browser: Browser, stripe: FakeStripe, providers: PaymentProviders, paying: tuple[str, str]
) -> None:
    checkout_id, intent_id = paying
    intent = stripe.intents[intent_id]
    intent["status"] = "processing"
    processing = stripe.event("payment_intent.processing", intent_id)
    stripe.succeed(intent_id)
    succeeded = stripe.event("payment_intent.succeeded", intent_id)

    await deliver(browser, succeeded)
    await process_events(providers)
    await deliver(browser, processing)  # sent first, arrives last
    await process_events(providers)

    assert await sql("SELECT status FROM payments") == "succeeded"
    assert await sql("SELECT status FROM orders") == "paid"
    assert await sql("SELECT count(*) FROM orders") == 1
    assert (await browser.get(f"/api/v1/checkout/{checkout_id}")).json()["status"] == "confirmed"


async def test_a_refund_event_before_the_success_event_still_ends_refunded(
    browser: Browser, stripe: FakeStripe, providers: PaymentProviders, paying: tuple[str, str]
) -> None:
    """Stripe does not promise order: the refund may land before we hear of the payment."""
    _, intent_id = paying
    stripe.succeed(intent_id)
    succeeded = stripe.event("payment_intent.succeeded", intent_id)
    amount = stripe.intents[intent_id]["amount"]
    refunded = stripe.event("charge.refunded", intent_id, amount_refunded=amount, id="ch_x")

    await deliver(browser, refunded)
    await process_events(providers)  # no order yet: held for retry, not dropped
    await deliver(browser, succeeded)
    await process_events(providers)
    # Due now — by a clock a minute behind, since the database's and ours may differ.
    await sql(
        "UPDATE payment_events SET next_attempt_at = now() - interval '1 minute' "
        "WHERE processed_at IS NULL"
    )
    await process_events(providers)

    assert await sql("SELECT count(*) FROM orders") == 1
    assert await sql("SELECT count(*) FROM payment_events WHERE processed_at IS NULL") == 0
    assert await sql("SELECT amount_refunded FROM payments") == amount


# ── Events we do not act on, providers we do not have ─────────────────────────


async def test_an_event_type_we_do_not_handle_is_acknowledged_and_changes_nothing(
    browser: Browser, providers: PaymentProviders, paying: tuple[str, str]
) -> None:
    body = event("customer.created", {"id": "cus_1"}, event_id="evt_customer")
    assert (await deliver(browser, signed(body))).status_code == 200
    await process_events(providers)

    assert await sql("SELECT count(*) FROM orders") == 0
    assert await sql("SELECT count(*) FROM payment_events WHERE processed_at IS NULL") == 0
    assert await sql("SELECT status FROM payments") == "pending"


async def test_a_provider_that_is_not_configured_has_no_webhook(
    browser: Browser, providers: PaymentProviders
) -> None:
    response = await browser.client.post(
        "/api/v1/webhooks/paystack",
        content=b'{"event": "charge.success", "data": {}}',
        headers={"X-Paystack-Signature": "00", "Content-Type": "application/json"},
    )
    assert response.status_code == 404
