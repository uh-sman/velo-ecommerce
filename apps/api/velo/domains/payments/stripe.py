"""Stripe — the primary provider (ADR-006).

Spoken over Stripe's REST API with httpx rather than through the SDK: every
call is a handful of form fields, the client is async and shares the
process's HTTP stack, and tests can put a fake Stripe behind
``httpx.MockTransport`` and exercise this exact code.

- **Idempotency.** Every POST carries an ``Idempotency-Key``. Checkout derives
  it from our payment id, so a retry after a crash gets the same intent back
  from Stripe instead of a second one.
- **Webhooks** are verified as Stripe specifies: HMAC-SHA256 over
  ``"{timestamp}.{raw body}"`` with the endpoint's signing secret, compared in
  constant time against every ``v1`` signature, within a 5-minute tolerance
  that stops an old, captured delivery from being replayed.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from collections.abc import Callable
from typing import Any

import httpx

from velo.domains.payments.provider import (
    DisputeInfo,
    EventKind,
    IntentStatus,
    PaymentIntent,
    ProviderError,
    RefundReason,
    RefundResult,
    SignatureError,
    WebhookEvent,
)

API_VERSION = "2024-06-20"  # pinned: a Stripe-side upgrade must not change our parsing
SIGNATURE_TOLERANCE_SECONDS = 300

_STATUSES = {
    "requires_payment_method": IntentStatus.REQUIRES_PAYMENT,
    "requires_confirmation": IntentStatus.REQUIRES_PAYMENT,
    "requires_action": IntentStatus.REQUIRES_ACTION,
    "processing": IntentStatus.PROCESSING,
    "requires_capture": IntentStatus.PROCESSING,  # authorised; captured automatically
    "succeeded": IntentStatus.SUCCEEDED,
    "canceled": IntentStatus.CANCELLED,
}

_EVENTS = {
    "payment_intent.succeeded": EventKind.PAYMENT_SUCCEEDED,
    "payment_intent.payment_failed": EventKind.PAYMENT_FAILED,
    "payment_intent.canceled": EventKind.PAYMENT_CANCELLED,
    "payment_intent.processing": EventKind.PAYMENT_PROCESSING,
    "payment_intent.requires_action": EventKind.PAYMENT_REQUIRES_ACTION,
    "charge.refunded": EventKind.CHARGE_REFUNDED,
    "charge.dispute.created": EventKind.DISPUTE_CREATED,
    "charge.dispute.closed": EventKind.DISPUTE_CLOSED,
}

# Stripe accepts three reasons; ours are finer, and the rest travel as metadata.
_REFUND_REASONS = {
    RefundReason.REQUESTED_BY_CUSTOMER: "requested_by_customer",
    RefundReason.DUPLICATE: "duplicate",
    RefundReason.FRAUDULENT: "fraudulent",
}
_REFUND_STATUSES = {"canceled": "cancelled", "requires_action": "pending"}


def sign(payload: bytes, secret: str, timestamp: int) -> str:
    """A ``Stripe-Signature`` header value — what Stripe sends, and what tests forge."""
    digest = hmac.new(secret.encode(), f"{timestamp}.".encode() + payload, hashlib.sha256)
    return f"t={timestamp},v1={digest.hexdigest()}"


def _form(fields: dict[str, Any], prefix: str = "") -> dict[str, str]:
    """Stripe's bracketed form encoding: ``{"metadata": {"a": "1"}}`` → ``metadata[a]=1``."""
    flat: dict[str, str] = {}
    for key, value in fields.items():
        name = f"{prefix}[{key}]" if prefix else key
        if isinstance(value, dict):
            flat.update(_form(value, name))
        elif isinstance(value, bool):
            flat[name] = "true" if value else "false"
        elif value is not None:
            flat[name] = str(value)
    return flat


class StripeProvider:
    name = "stripe"

    def __init__(
        self,
        *,
        secret_key: str,
        publishable_key: str,
        webhook_secret: str,
        api_base: str = "https://api.stripe.com",
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = 15.0,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.publishable_key = publishable_key
        self._webhook_secret = webhook_secret
        self._clock = clock
        self._http = httpx.AsyncClient(
            base_url=api_base,
            transport=transport,
            timeout=httpx.Timeout(timeout, connect=5.0),
            headers={"Authorization": f"Bearer {secret_key}", "Stripe-Version": API_VERSION},
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    # ── Intents ───────────────────────────────────────────────────────────

    async def create_intent(
        self,
        *,
        amount: int,
        currency: str,
        idempotency_key: str,
        metadata: dict[str, str],
        email: str,
    ) -> PaymentIntent:
        del email  # receipts are ours to send; Stripe does not need it
        body = await self._post(
            "/v1/payment_intents",
            {
                "amount": amount,
                "currency": currency.lower(),
                # Cards, Apple Pay, Google Pay, Link — whatever the dashboard enables.
                "automatic_payment_methods": {"enabled": True},
                "metadata": metadata,
            },
            idempotency_key,
        )
        return self._intent(body)

    async def get_intent(self, intent_id: str) -> PaymentIntent:
        return self._intent(
            await self._request(
                "GET", f"/v1/payment_intents/{intent_id}", params={"expand[]": "latest_charge"}
            )
        )

    async def capture(self, intent_id: str, *, idempotency_key: str) -> PaymentIntent:
        return self._intent(
            await self._post(f"/v1/payment_intents/{intent_id}/capture", {}, idempotency_key)
        )

    async def cancel(self, intent_id: str, *, idempotency_key: str) -> PaymentIntent:
        return self._intent(
            await self._post(f"/v1/payment_intents/{intent_id}/cancel", {}, idempotency_key)
        )

    async def refund(
        self, *, intent_id: str, amount: int, reason: RefundReason, idempotency_key: str
    ) -> RefundResult:
        body = await self._post(
            "/v1/refunds",
            {
                "payment_intent": intent_id,
                "amount": amount,
                "reason": _REFUND_REASONS.get(reason),
                "metadata": {"reason": reason.value},
            },
            idempotency_key,
        )
        status = str(body.get("status", "pending"))
        return RefundResult(
            id=str(body["id"]),
            status=_REFUND_STATUSES.get(status, status),
            amount=int(body["amount"]),
        )

    # ── Webhooks ──────────────────────────────────────────────────────────

    def verify_webhook(self, raw_body: bytes, signature: str) -> WebhookEvent:
        if not self._webhook_secret:
            raise SignatureError("no webhook secret configured")
        timestamp: int | None = None
        candidates: list[str] = []
        for part in signature.split(","):
            key, _, value = part.strip().partition("=")
            if key == "t" and value.isdigit():
                timestamp = int(value)
            elif key == "v1" and value:
                candidates.append(value)
        if timestamp is None or not candidates:
            raise SignatureError("malformed signature header")
        if abs(self._clock() - timestamp) > SIGNATURE_TOLERANCE_SECONDS:
            raise SignatureError("signature timestamp outside tolerance")
        expected = hmac.new(
            self._webhook_secret.encode(), f"{timestamp}.".encode() + raw_body, hashlib.sha256
        ).hexdigest()
        if not any(hmac.compare_digest(expected, candidate) for candidate in candidates):
            raise SignatureError("signature mismatch")
        # Only now is the body parsed: it is known to be Stripe's.
        try:
            payload = json.loads(raw_body)
        except ValueError as exc:
            raise SignatureError("signed body is not JSON") from exc
        if not isinstance(payload, dict) or "id" not in payload or "type" not in payload:
            raise SignatureError("signed body is not an event")
        try:
            return self.parse_event(payload)
        except (KeyError, TypeError, ValueError, AttributeError) as exc:
            # Stripe never sends these; refusing beats storing an event that can only fail.
            raise SignatureError("signed body is not a well-formed event") from exc

    def parse_event(self, payload: dict[str, Any]) -> WebhookEvent:
        event_type = str(payload["type"])
        kind = _EVENTS.get(event_type, EventKind.OTHER)
        obj: dict[str, Any] = payload.get("data", {}).get("object", {}) or {}
        intent: PaymentIntent | None = None
        intent_id: str | None = None
        amount_refunded: int | None = None
        dispute: DisputeInfo | None = None

        if event_type.startswith("payment_intent."):
            intent = self._intent(obj)
            intent_id = intent.id
        elif event_type.startswith("charge.dispute."):
            intent_id = _str(obj.get("payment_intent"))
            dispute = DisputeInfo(
                id=str(obj.get("id", "")),
                amount=int(obj.get("amount", 0)),
                reason=_str(obj.get("reason")),
                status=_str(obj.get("status")),
            )
        elif event_type.startswith("charge."):
            intent_id = _str(obj.get("payment_intent"))
            amount_refunded = int(obj.get("amount_refunded", 0))

        return WebhookEvent(
            id=str(payload["id"]),
            type=event_type,
            kind=kind,
            intent_id=intent_id,
            payload=payload,
            payment_ref=intent.metadata.get("payment_id") if intent else None,
            intent=intent,
            amount_refunded=amount_refunded,
            dispute=dispute,
        )

    # ── Plumbing ──────────────────────────────────────────────────────────

    async def _post(self, path: str, fields: dict[str, Any], idempotency_key: str) -> Any:
        return await self._request(
            "POST", path, data=_form(fields), headers={"Idempotency-Key": idempotency_key}
        )

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            response = await self._http.request(method, path, **kwargs)
        except httpx.HTTPError as exc:
            raise ProviderError(
                f"stripe unreachable: {type(exc).__name__}", retryable=True
            ) from exc
        if response.status_code >= 400:
            try:
                error = response.json().get("error", {})
            except ValueError:
                error = {}
            retryable = response.status_code >= 500 or response.status_code in (409, 429)
            raise ProviderError(
                str(error.get("message") or f"stripe returned {response.status_code}"),
                retryable=retryable,
                code=_str(error.get("code")),
            )
        return response.json()

    @staticmethod
    def _intent(body: dict[str, Any]) -> PaymentIntent:
        charge = body.get("latest_charge")
        charge_id: str | None = None
        method_type: str | None = None
        brand: str | None = None
        last4: str | None = None
        refunded = 0
        if isinstance(charge, dict):
            charge_id = _str(charge.get("id"))
            details = charge.get("payment_method_details") or {}
            method_type = _str(details.get("type"))
            card = details.get("card") or {}
            brand = _str(card.get("brand"))
            last4 = _str(card.get("last4"))
            wallet = (card.get("wallet") or {}).get("type")
            if wallet:
                method_type = str(wallet)  # 'apple_pay', 'google_pay', 'link'
            refunded = int(charge.get("amount_refunded", 0))
        else:
            charge_id = _str(charge)
        error = body.get("last_payment_error") or {}
        status = _STATUSES.get(str(body.get("status")), IntentStatus.PROCESSING)
        return PaymentIntent(
            id=str(body["id"]),
            status=status,
            amount=int(body.get("amount", 0)),
            currency=str(body.get("currency", "")).upper(),
            amount_received=int(body.get("amount_received", 0)),
            client_secret=_str(body.get("client_secret")),
            charge_id=charge_id,
            payment_method_type=method_type,
            card_brand=brand,
            card_last4=last4,
            failure_code=_str(error.get("decline_code") or error.get("code")),
            failure_message=_str(error.get("message")),
            amount_refunded=refunded,
            metadata={str(k): str(v) for k, v in (body.get("metadata") or {}).items()},
        )


def _str(value: Any) -> str | None:
    return None if value is None else str(value)
