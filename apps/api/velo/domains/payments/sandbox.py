"""A payment provider that never leaves the building — development and E2E only.

The Playwright journeys (PLANNING.md Phase 13) pay, decline and refund in a
real browser without Stripe keys or network access. This provider answers the
same protocol as Stripe, keeps its intents in Redis so the API and the worker
see the same ones, and delivers its events through the real webhook path —
signed, recorded, deduplicated, processed by the worker — so nothing above it
can tell it apart from a real provider.

The browser never sends a card number: the sandbox form maps Stripe's test
numbers to an *outcome* (``succeed`` or ``decline``) on the client, and only
that crosses the wire. Refused at startup in production (config.py).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import time
import uuid
from collections.abc import Callable
from typing import Any, Literal

from redis.asyncio import Redis

from velo.domains.payments.provider import (
    EventKind,
    IntentStatus,
    PaymentIntent,
    ProviderError,
    RefundReason,
    RefundResult,
    SignatureError,
    WebhookEvent,
)

Outcome = Literal["succeed", "decline"]

_TTL_SECONDS = 7 * 24 * 3600
_EVENTS = {
    "payment_intent.succeeded": EventKind.PAYMENT_SUCCEEDED,
    "payment_intent.payment_failed": EventKind.PAYMENT_FAILED,
    "payment_intent.canceled": EventKind.PAYMENT_CANCELLED,
}


def _already_succeeded() -> ProviderError:
    return ProviderError("intent already succeeded", retryable=False, code="unexpected_state")


def sign(payload: bytes, secret: str) -> str:
    return hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()


class SandboxProvider:
    name = "sandbox"

    def __init__(self, redis: Callable[[], Redis], *, secret: str) -> None:
        self._redis_factory = redis  # resolved per call: the client is made in the lifespan
        self._secret = secret
        self.publishable_key = "pk_sandbox"

    # ── Intents ───────────────────────────────────────────────────────────

    @property
    def _redis(self) -> Redis:
        return self._redis_factory()

    def _key(self, intent_id: str) -> str:
        return f"sandbox:intent:{intent_id}"

    async def _load(self, intent_id: str) -> dict[str, Any]:
        raw = await self._redis.get(self._key(intent_id))
        if raw is None:
            raise ProviderError(f"no sandbox intent {intent_id}", retryable=False, code="missing")
        data: dict[str, Any] = json.loads(raw)
        return data

    async def _save(self, data: dict[str, Any]) -> None:
        await self._redis.set(self._key(data["id"]), json.dumps(data), ex=_TTL_SECONDS)

    @staticmethod
    def _intent(data: dict[str, Any]) -> PaymentIntent:
        return PaymentIntent(
            id=data["id"],
            status=IntentStatus(data["status"]),
            amount=int(data["amount"]),
            currency=str(data["currency"]).upper(),
            amount_received=int(data.get("amount_received", 0)),
            client_secret=data.get("client_secret"),
            charge_id=data.get("charge_id"),
            payment_method_type="card" if data.get("card_last4") else None,
            card_brand=data.get("card_brand"),
            card_last4=data.get("card_last4"),
            failure_code=data.get("failure_code"),
            failure_message=data.get("failure_message"),
            amount_refunded=int(data.get("amount_refunded", 0)),
            metadata=dict(data.get("metadata", {})),
        )

    async def create_intent(
        self,
        *,
        amount: int,
        currency: str,
        idempotency_key: str,
        metadata: dict[str, str],
        email: str,
    ) -> PaymentIntent:
        intent_id = f"sbx_pi_{uuid.uuid4().hex[:20]}"
        claimed = await self._redis.set(
            f"sandbox:idem:{idempotency_key}", intent_id, nx=True, ex=_TTL_SECONDS
        )
        if not claimed:  # the same key: the same intent, like Stripe
            existing = await self._redis.get(f"sandbox:idem:{idempotency_key}")
            return self._intent(await self._load(str(existing)))
        data = {
            "id": intent_id,
            "status": IntentStatus.REQUIRES_PAYMENT.value,
            "amount": amount,
            "currency": currency.lower(),
            "client_secret": f"{intent_id}_secret_{secrets.token_urlsafe(12)}",
            "metadata": metadata,
        }
        await self._save(data)
        return self._intent(data)

    async def get_intent(self, intent_id: str) -> PaymentIntent:
        return self._intent(await self._load(intent_id))

    async def capture(self, intent_id: str, *, idempotency_key: str) -> PaymentIntent:
        return await self.get_intent(intent_id)

    async def cancel(self, intent_id: str, *, idempotency_key: str) -> PaymentIntent:
        data = await self._load(intent_id)
        if data["status"] == IntentStatus.SUCCEEDED.value:
            raise _already_succeeded()
        data["status"] = IntentStatus.CANCELLED.value
        await self._save(data)
        return self._intent(data)

    async def refund(
        self, *, intent_id: str, amount: int, reason: RefundReason, idempotency_key: str
    ) -> RefundResult:
        done = await self._redis.get(f"sandbox:refund:{idempotency_key}")
        if done is not None:
            stored = json.loads(done)
            return RefundResult(id=stored["id"], status="succeeded", amount=stored["amount"])
        data = await self._load(intent_id)
        if int(data.get("amount_refunded", 0)) + amount > int(data.get("amount_received", 0)):
            raise ProviderError("refund exceeds charge", retryable=False, code="amount_too_large")
        data["amount_refunded"] = int(data.get("amount_refunded", 0)) + amount
        await self._save(data)
        refund_id = f"sbx_re_{uuid.uuid4().hex[:16]}"
        await self._redis.set(
            f"sandbox:refund:{idempotency_key}",
            json.dumps({"id": refund_id, "amount": amount}),
            ex=_TTL_SECONDS,
        )
        return RefundResult(id=refund_id, status="succeeded", amount=amount)

    # ── What the customer does in the sandbox form ────────────────────────

    async def confirm(
        self, intent_id: str, client_secret: str, outcome: Outcome
    ) -> tuple[PaymentIntent, bytes, str]:
        """Settle the intent and return it with the signed event to deliver.

        Raises :class:`SignatureError` for a wrong client secret: only the
        browser that was handed the intent can pay it.
        """
        data = await self._load(intent_id)
        if not hmac.compare_digest(str(data.get("client_secret", "")), client_secret):
            raise SignatureError("client secret does not match")
        if data["status"] == IntentStatus.SUCCEEDED.value:
            raise _already_succeeded()
        if outcome == "succeed":
            data.update(
                status=IntentStatus.SUCCEEDED.value,
                amount_received=data["amount"],
                charge_id=f"sbx_ch_{uuid.uuid4().hex[:16]}",
                card_brand="visa",
                card_last4="4242",
                failure_code=None,
                failure_message=None,
            )
            event_type = "payment_intent.succeeded"
        else:
            data.update(
                status=IntentStatus.REQUIRES_PAYMENT.value,
                failure_code="card_declined",
                failure_message="Your card was declined.",
            )
            event_type = "payment_intent.payment_failed"
        await self._save(data)
        body = json.dumps(
            {
                "id": f"sbx_evt_{uuid.uuid4().hex[:16]}",
                "type": event_type,
                "created": int(time.time()),
                "data": {"object": data},
            }
        ).encode()
        return self._intent(data), body, sign(body, self._secret)

    # ── Webhooks ──────────────────────────────────────────────────────────

    def verify_webhook(self, raw_body: bytes, signature: str) -> WebhookEvent:
        if not hmac.compare_digest(sign(raw_body, self._secret), signature):
            raise SignatureError("signature mismatch")
        try:
            payload = json.loads(raw_body)
        except ValueError as exc:
            raise SignatureError("signed body is not JSON") from exc
        if not isinstance(payload, dict) or "id" not in payload or "type" not in payload:
            raise SignatureError("signed body is not an event")
        return self.parse_event(payload)

    def parse_event(self, payload: dict[str, Any]) -> WebhookEvent:
        event_type = str(payload["type"])
        obj = payload.get("data", {}).get("object", {}) or {}
        intent = self._intent(obj) if obj.get("id") else None
        return WebhookEvent(
            id=str(payload["id"]),
            type=event_type,
            kind=_EVENTS.get(event_type, EventKind.OTHER),
            intent_id=intent.id if intent else None,
            payload=payload,
            payment_ref=intent.metadata.get("payment_id") if intent else None,
            intent=intent,
        )

    async def aclose(self) -> None:
        return None
