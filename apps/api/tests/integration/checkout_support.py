"""Checkout test support: a fake Stripe, and the steps of a checkout.

``FakeStripe`` answers the Stripe REST calls the real :class:`StripeProvider`
makes, behind ``httpx.MockTransport``, and signs webhook events with the same
scheme Stripe uses. So these tests run the production adapter end to end:
form encoding, idempotency keys, signature verification, event parsing.
"""

from __future__ import annotations

import asyncio
import itertools
import json
import time
import uuid
from collections.abc import Iterator
from typing import Any
from urllib.parse import parse_qsl

import httpx

from tests.integration.conftest import Browser
from velo.core.config import get_settings
from velo.db.redis import get_redis
from velo.db.session import open_session
from velo.domains.catalog.cache import CatalogCache
from velo.domains.checkout.processing import (
    CheckoutSweeper,
    PaymentEventProcessor,
    Reconciler,
    build_settlement,
)
from velo.domains.inventory.service import InventoryService
from velo.domains.payments.registry import PaymentProviders
from velo.domains.payments.stripe import StripeProvider, sign

WEBHOOK_SECRET = "whsec_test_secret"
US_ADDRESS = {
    "first_name": "Ada",
    "last_name": "Lovelace",
    "line1": "1 Market St",
    "city": "San Francisco",
    "region": "ca",
    "postal_code": "94103",
    "country_code": "us",
}


class FakeStripe:
    def __init__(self) -> None:
        self.intents: dict[str, dict[str, Any]] = {}
        self.by_key: dict[str, str] = {}
        self.requests: list[tuple[str, str, dict[str, str]]] = []
        self.delay = 0.0  # seconds, to hold a request open
        self.down = False
        self.refunds_by_key: dict[str, dict[str, Any]] = {}
        self.refund_status = "succeeded"  # what a new refund reports
        self._ids: Iterator[int] = itertools.count(1)

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    async def handle(self, request: httpx.Request) -> httpx.Response:
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.down:
            return httpx.Response(503, json={"error": {"message": "Stripe is down"}})
        form = dict(parse_qsl(request.content.decode())) if request.content else {}
        path = request.url.path
        self.requests.append((request.method, path, form))
        key = request.headers.get("Idempotency-Key", "")
        if request.method == "POST" and path == "/v1/payment_intents":
            if key in self.by_key:  # Stripe's idempotency: the same answer again
                return httpx.Response(200, json=self.intents[self.by_key[key]])
            intent_id = f"pi_{next(self._ids)}"
            self.intents[intent_id] = {
                "id": intent_id,
                "object": "payment_intent",
                "amount": int(form["amount"]),
                "amount_received": 0,
                "currency": form["currency"],
                "status": "requires_payment_method",
                "client_secret": f"{intent_id}_secret_abc",
                "latest_charge": None,
                "last_payment_error": None,
                "metadata": {
                    k[len("metadata[") : -1]: v
                    for k, v in form.items()
                    if k.startswith("metadata[")
                },
            }
            self.by_key[key] = intent_id
            return httpx.Response(200, json=self.intents[intent_id])
        if request.method == "POST" and path == "/v1/refunds":
            return self._refund(form, key)
        parts = path.strip("/").split("/")
        if len(parts) >= 3 and parts[1] == "payment_intents":
            intent = self.intents.get(parts[2])
            if intent is None:
                return httpx.Response(404, json={"error": {"code": "resource_missing"}})
            if len(parts) == 4 and parts[3] == "cancel":
                if intent["status"] == "succeeded":
                    return httpx.Response(
                        400,
                        json={"error": {"code": "payment_intent_unexpected_state", "message": "x"}},
                    )
                intent["status"] = "canceled"
            return httpx.Response(200, json=intent)
        return httpx.Response(404, json={"error": {"message": f"no fake for {path}"}})

    def _refund(self, form: dict[str, str], key: str) -> httpx.Response:
        """``POST /v1/refunds``: idempotent by key, bounded by what was captured."""
        if key in self.refunds_by_key:
            return httpx.Response(200, json=self.refunds_by_key[key])
        intent = self.intents.get(form.get("payment_intent", ""))
        if intent is None:
            return httpx.Response(404, json={"error": {"code": "resource_missing"}})
        charge = intent.get("latest_charge") or {}
        amount = int(form["amount"])
        if charge.get("amount_refunded", 0) + amount > intent["amount_received"]:
            return httpx.Response(
                400,
                json={"error": {"code": "amount_too_large", "message": "Refund exceeds charge"}},
            )
        charge["amount_refunded"] = charge.get("amount_refunded", 0) + amount
        refund = {
            "id": f"re_{next(self._ids)}",
            "object": "refund",
            "amount": amount,
            "status": self.refund_status,
            "payment_intent": intent["id"],
        }
        self.refunds_by_key[key] = refund
        return httpx.Response(200, json=refund)

    def refunded(self, intent_id: str) -> int:
        return int((self.intents[intent_id].get("latest_charge") or {}).get("amount_refunded", 0))

    # ── What happens at Stripe while the customer pays ────────────────────

    def only_intent(self) -> str:
        assert len(self.intents) == 1, self.intents.keys()
        return next(iter(self.intents))

    def succeed(self, intent_id: str, *, brand: str = "visa", last4: str = "4242") -> None:
        intent = self.intents[intent_id]
        intent["status"] = "succeeded"
        intent["amount_received"] = intent["amount"]
        intent["last_payment_error"] = None
        intent["latest_charge"] = {
            "id": f"ch_{intent_id}",
            "amount_refunded": 0,
            "payment_method_details": {"type": "card", "card": {"brand": brand, "last4": last4}},
        }

    def decline(self, intent_id: str) -> None:
        intent = self.intents[intent_id]
        intent["status"] = "requires_payment_method"
        intent["last_payment_error"] = {
            "code": "card_declined",
            "decline_code": "insufficient_funds",
            "message": "Your card has insufficient funds.",
        }

    def event(
        self, event_type: str, intent_id: str, *, event_id: str | None = None, **obj: Any
    ) -> tuple[bytes, str]:
        """A signed delivery: the raw body, and its Stripe-Signature header."""
        if event_type.startswith("payment_intent."):
            data = dict(self.intents[intent_id])
            data["latest_charge"] = (data.get("latest_charge") or {}).get("id")  # not expanded
        else:
            data = {"payment_intent": intent_id, **obj}
        body = json.dumps(
            {
                "id": event_id or f"evt_{uuid.uuid4().hex[:16]}",
                "object": "event",
                "type": event_type,
                "data": {"object": data},
            }
        ).encode()
        return body, sign(body, WEBHOOK_SECRET, int(time.time()))


def providers_for(fake: FakeStripe) -> PaymentProviders:
    return PaymentProviders(
        {
            "stripe": StripeProvider(
                secret_key="sk_test_fake",
                publishable_key="pk_test_fake",
                webhook_secret=WEBHOOK_SECRET,
                transport=fake.transport(),
            )
        }
    )


# ── Steps ─────────────────────────────────────────────────────────────────────


def key() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid.uuid4())}


async def start(browser: Browser, email: str | None = "ada@example.com", **kw: Any) -> Any:
    body = {"email": email} if email else {}
    return await browser.post("/api/v1/checkout", json=body, headers=kw.pop("headers", key()))


async def to_payment(browser: Browser, checkout_id: str) -> dict[str, Any]:
    """Address, then the first shipping rate. Returns the checkout."""
    response = await browser.patch(
        f"/api/v1/checkout/{checkout_id}/address", json={"shipping_address": US_ADDRESS}
    )
    assert response.status_code == 200, response.text
    rates = (await browser.get(f"/api/v1/checkout/{checkout_id}/shipping-rates")).json()
    response = await browser.patch(
        f"/api/v1/checkout/{checkout_id}/shipping",
        json={"shipping_rate_id": rates["options"][0]["id"]},
    )
    assert response.status_code == 200, response.text
    return dict(response.json())


async def pay(browser: Browser, checkout_id: str, headers: dict[str, str] | None = None) -> Any:
    return await browser.post(
        f"/api/v1/checkout/{checkout_id}/payment-intent", headers=headers or key()
    )


async def deliver(browser: Browser, delivery: tuple[bytes, str]) -> Any:
    body, signature = delivery
    return await browser.client.post(
        "/api/v1/webhooks/stripe",
        content=body,
        headers={"Stripe-Signature": signature, "Content-Type": "application/json"},
    )


def _cache() -> CatalogCache:
    return CatalogCache(get_redis(), get_settings().catalog_cache_ttl_seconds)


async def process_events(providers: PaymentProviders) -> dict[str, int]:
    """What the worker does after a webhook: apply every due event."""
    async with open_session() as session:
        processor = PaymentEventProcessor(
            session,
            providers=providers,
            settlement=build_settlement(session, get_settings(), _cache()),
        )
        return await processor.process_due()


async def reconcile(providers: PaymentProviders, **kwargs: Any) -> dict[str, int]:
    async with open_session() as session:
        reconciler = Reconciler(
            session,
            providers=providers,
            settlement=build_settlement(session, get_settings(), _cache()),
            **kwargs,
        )
        return await reconciler.run()


async def sweep() -> dict[str, int]:
    async with open_session() as session:
        return await CheckoutSweeper(session, InventoryService(session)).sweep()
