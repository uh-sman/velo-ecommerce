"""The sandbox payment provider: the same path to an order as a real one (payments/sandbox.py).

E2E and load tests pay with it, so it has to be faithful: a decline leaves
the checkout payable, a success creates the order only through the stored,
signed event the worker processes, and a client secret is the only key.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI

from tests.integration.catalog_support import product, sql, variant
from tests.integration.checkout_support import pay, process_events, start, to_payment
from tests.integration.conftest import Browser
from tests.integration.test_cart import add, shipping_and_tax
from velo.db.redis import get_redis
from velo.domains.payments.registry import PaymentProviders
from velo.domains.payments.sandbox import SandboxProvider

pytestmark = pytest.mark.integration


@pytest.fixture
async def providers(live_app: FastAPI) -> PaymentProviders:
    from velo.api.deps import get_payment_providers

    configured = PaymentProviders(
        {"sandbox": SandboxProvider(get_redis, secret="sandbox-test")}, default="sandbox"
    )
    live_app.dependency_overrides[get_payment_providers] = lambda: configured
    return configured


@pytest.fixture
async def intent(browser: Browser, admin: Browser, providers: PaymentProviders) -> dict[str, Any]:
    await shipping_and_tax()
    made = await product(admin, "Teapot", variants=[variant(price=5000, stock=2, sku="TEAPOT")])
    assert (await add(browser, made["variants"][0]["id"])).status_code == 200
    checkout_id = (await start(browser)).json()["id"]
    await to_payment(browser, checkout_id)
    response = await pay(browser, checkout_id)
    assert response.status_code == 201, response.text
    body = dict(response.json())
    assert body["provider"] == "sandbox"
    return {**body, "checkout_id": checkout_id}


async def confirm(browser: Browser, client_secret: str, outcome: str) -> Any:
    return await browser.post(
        "/api/v1/sandbox/confirm", json={"client_secret": client_secret, "outcome": outcome}
    )


async def test_a_decline_then_a_retry_makes_one_order(
    browser: Browser, providers: PaymentProviders, intent: dict[str, Any]
) -> None:
    declined = await confirm(browser, intent["client_secret"], "decline")
    assert declined.status_code == 200
    assert declined.json() == {
        "status": "requires_payment",
        "failure_message": "Your card was declined.",
    }
    await process_events(providers)
    assert await sql("SELECT count(*) FROM orders") == 0
    declined_checkout = (await browser.get(f"/api/v1/checkout/{intent['checkout_id']}")).json()
    assert declined_checkout["status"] == "failed"  # as with Stripe: payable again, stock held

    paid = await confirm(browser, intent["client_secret"], "succeed")
    assert paid.status_code == 200 and paid.json()["status"] == "succeeded"
    assert await sql("SELECT count(*) FROM orders") == 0  # not until the worker runs
    await process_events(providers)

    assert await sql("SELECT count(*) FROM orders") == 1
    assert await sql("SELECT card_last4 FROM payments") == "4242"
    assert await sql("SELECT count(*) FROM payment_events WHERE provider = 'sandbox'") == 2
    again = await confirm(browser, intent["client_secret"], "succeed")
    assert again.status_code == 422  # paid is paid


async def test_only_the_client_secret_pays(
    browser: Browser, providers: PaymentProviders, intent: dict[str, Any]
) -> None:
    intent_id = intent["client_secret"].split("_secret_")[0]
    forged = await confirm(browser, f"{intent_id}_secret_guessed-wrong", "succeed")
    assert forged.status_code == 422
    unknown = await confirm(browser, "sbx_pi_nothing_secret_nothing", "succeed")
    assert unknown.status_code == 422
    assert await sql("SELECT count(*) FROM payment_events") == 0


async def test_without_the_sandbox_the_route_does_not_exist(
    live_app: FastAPI, browser: Browser
) -> None:
    from velo.api.deps import get_payment_providers

    live_app.dependency_overrides[get_payment_providers] = lambda: PaymentProviders({})
    response = await confirm(browser, "sbx_pi_x_secret_y1234", "succeed")
    assert response.status_code == 404


async def test_refunds_are_bounded_by_what_was_paid(providers: PaymentProviders) -> None:
    from velo.domains.payments.provider import ProviderError, RefundReason

    sandbox = providers.get("sandbox")
    assert isinstance(sandbox, SandboxProvider)
    created = await sandbox.create_intent(
        amount=1000, currency="USD", idempotency_key="k1", metadata={}, email="a@b.c"
    )
    assert (
        await sandbox.create_intent(
            amount=1000, currency="USD", idempotency_key="k1", metadata={}, email="a@b.c"
        )
    ).id == created.id
    assert created.client_secret is not None
    await sandbox.confirm(created.id, created.client_secret, "succeed")

    first = await sandbox.refund(
        intent_id=created.id, amount=600, reason=RefundReason.OTHER, idempotency_key="r1"
    )
    repeat = await sandbox.refund(
        intent_id=created.id, amount=600, reason=RefundReason.OTHER, idempotency_key="r1"
    )
    assert first.id == repeat.id
    with pytest.raises(ProviderError):
        await sandbox.refund(
            intent_id=created.id, amount=600, reason=RefundReason.OTHER, idempotency_key="r2"
        )
    assert (await sandbox.get_intent(created.id)).amount_refunded == 600
