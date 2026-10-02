"""Paystack — the second provider, for Nigeria, Ghana, South Africa and Kenya (ADR-006).

The same protocol as Stripe, with Paystack's shape mapped onto it:

- An intent is a *transaction*, identified by a ``reference`` we choose. We use
  the idempotency key, so initialising twice for one payment is refused by
  Paystack as a duplicate and answered here by fetching the first.
- ``client_secret`` is the transaction's ``access_code``, which Paystack's
  inline checkout takes. Card entry happens in Paystack's iframe, as with
  Stripe (PAYMENTS-AND-CHECKOUT.md §9).
- Paystack captures on success and cannot cancel a transaction: an unpaid one
  simply lapses. :meth:`PaystackProvider.cancel` reports it cancelled unless it
  was paid — and if it is paid later anyway, the webhook still creates the
  order (checkout/state.py: ``expired → confirmed``).
- Webhooks carry ``x-paystack-signature``: HMAC-SHA512 of the raw body under
  the secret key. Events have no id of their own; the event name plus the
  transaction's (or refund's) id is unique, and is used to deduplicate.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any

import httpx

from velo.domains.payments.provider import (
    DisputeInfo,
    EventKind,
    IntentStatus,
    PaymentIntent,
    ProviderError,
    RefundInfo,
    RefundReason,
    RefundResult,
    SignatureError,
    WebhookEvent,
)

_STATUSES = {
    "success": IntentStatus.SUCCEEDED,
    "failed": IntentStatus.FAILED,
    "abandoned": IntentStatus.REQUIRES_PAYMENT,  # opened, not paid: still payable
    "ongoing": IntentStatus.REQUIRES_ACTION,  # waiting on an OTP, a transfer, a USSD step
    "pending": IntentStatus.PROCESSING,
    "processing": IntentStatus.PROCESSING,
    "queued": IntentStatus.PROCESSING,
    "reversed": IntentStatus.CANCELLED,
}

_EVENTS = {
    "charge.success": EventKind.PAYMENT_SUCCEEDED,
    "charge.failed": EventKind.PAYMENT_FAILED,
    "refund.processed": EventKind.CHARGE_REFUNDED,
    "charge.dispute.create": EventKind.DISPUTE_CREATED,
    "charge.dispute.resolve": EventKind.DISPUTE_CLOSED,
}


def sign(payload: bytes, secret: str) -> str:
    return hmac.new(secret.encode(), payload, hashlib.sha512).hexdigest()


class PaystackProvider:
    name = "paystack"

    def __init__(
        self,
        *,
        secret_key: str,
        public_key: str,
        api_base: str = "https://api.paystack.co",
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = 15.0,
    ) -> None:
        self.publishable_key = public_key
        self._secret = secret_key
        self._http = httpx.AsyncClient(
            base_url=api_base,
            transport=transport,
            timeout=httpx.Timeout(timeout, connect=5.0),
            headers={"Authorization": f"Bearer {secret_key}"},
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def create_intent(
        self,
        *,
        amount: int,
        currency: str,
        idempotency_key: str,
        metadata: dict[str, str],
        email: str,
    ) -> PaymentIntent:
        try:
            data = await self._request(
                "POST",
                "/transaction/initialize",
                json={
                    "email": email,
                    "amount": amount,
                    "currency": currency.upper(),
                    "reference": idempotency_key,
                    "metadata": metadata,
                },
            )
        except ProviderError as exc:
            if exc.code != "duplicate_reference":
                raise
            return await self.get_intent(idempotency_key)  # the first attempt got through
        return PaymentIntent(
            id=str(data["reference"]),
            status=IntentStatus.REQUIRES_PAYMENT,
            amount=amount,
            currency=currency.upper(),
            client_secret=str(data["access_code"]),
            metadata=metadata,
        )

    async def get_intent(self, intent_id: str) -> PaymentIntent:
        return self._intent(await self._request("GET", f"/transaction/verify/{intent_id}"))

    async def capture(self, intent_id: str, *, idempotency_key: str) -> PaymentIntent:
        del idempotency_key  # Paystack captures on success
        return await self.get_intent(intent_id)

    async def cancel(self, intent_id: str, *, idempotency_key: str) -> PaymentIntent:
        del idempotency_key
        intent = await self.get_intent(intent_id)
        if intent.status in (IntentStatus.SUCCEEDED, IntentStatus.PROCESSING):
            return intent
        return PaymentIntent(
            id=intent.id,
            status=IntentStatus.CANCELLED,
            amount=intent.amount,
            currency=intent.currency,
            metadata=intent.metadata,
        )

    async def refund(
        self, *, intent_id: str, amount: int, reason: RefundReason, idempotency_key: str
    ) -> RefundResult:
        data = await self._request(
            "POST",
            "/refund",
            json={
                "transaction": intent_id,
                "amount": amount,
                "merchant_note": f"{reason.value} ({idempotency_key})",
            },
        )
        status = str(data.get("status", "pending"))
        return RefundResult(
            id=str(data.get("id", "")),
            status="succeeded" if status == "processed" else status,
            amount=int(data.get("amount", amount)),
        )

    # ── Webhooks ──────────────────────────────────────────────────────────

    def verify_webhook(self, raw_body: bytes, signature: str) -> WebhookEvent:
        if not self._secret:
            raise SignatureError("no secret key configured")
        if not signature or not hmac.compare_digest(sign(raw_body, self._secret), signature):
            raise SignatureError("signature mismatch")
        try:
            payload = json.loads(raw_body)
        except ValueError as exc:
            raise SignatureError("signed body is not JSON") from exc
        if not isinstance(payload, dict) or "event" not in payload:
            raise SignatureError("signed body is not an event")
        try:
            return self.parse_event(payload)
        except (KeyError, TypeError, ValueError, AttributeError) as exc:
            raise SignatureError("signed body is not a well-formed event") from exc

    def parse_event(self, payload: dict[str, Any]) -> WebhookEvent:
        event_type = str(payload["event"])
        data: dict[str, Any] = payload.get("data") or {}
        kind = _EVENTS.get(event_type, EventKind.OTHER)
        intent: PaymentIntent | None = None
        refund: RefundInfo | None = None
        dispute: DisputeInfo | None = None
        intent_id = _str(data.get("reference"))

        if event_type.startswith("charge.dispute"):
            transaction = data.get("transaction") or {}
            intent_id = _str(transaction.get("reference"))
            dispute = DisputeInfo(
                id=str(data.get("id", "")),
                amount=int(data.get("refund_amount") or transaction.get("amount") or 0),
                reason=_str(data.get("category")),
                status=_str(data.get("status") or data.get("resolution")),
            )
        elif event_type.startswith("refund."):
            intent_id = _str(data.get("transaction_reference"))
            refund = RefundInfo(
                id=str(data.get("id", "")),
                amount=int(data.get("amount", 0)),
                status="succeeded" if data.get("status") == "processed" else "pending",
            )
        elif event_type.startswith("charge."):
            intent = self._intent(data)

        metadata = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}
        return WebhookEvent(
            # Unique per event: Paystack sends no event id.
            id=f"{event_type}:{data.get('id', intent_id)}",
            type=event_type,
            kind=kind,
            intent_id=intent_id,
            payload=payload,
            payment_ref=_str((metadata or {}).get("payment_id")),
            intent=intent,
            refund=refund,
            dispute=dispute,
        )

    # ── Plumbing ──────────────────────────────────────────────────────────

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            response = await self._http.request(method, path, **kwargs)
        except httpx.HTTPError as exc:
            raise ProviderError(
                f"paystack unreachable: {type(exc).__name__}", retryable=True
            ) from exc
        try:
            body = response.json()
        except ValueError:
            body = {}
        if response.status_code >= 400 or not body.get("status"):
            message = str(body.get("message") or f"paystack returned {response.status_code}")
            code = "duplicate_reference" if "duplicate" in message.lower() else body.get("code")
            raise ProviderError(
                message,
                retryable=response.status_code >= 500 or response.status_code == 429,
                code=_str(code),
            )
        return body.get("data") or {}

    @staticmethod
    def _intent(data: dict[str, Any]) -> PaymentIntent:
        authorization = data.get("authorization") or {}
        status = _STATUSES.get(str(data.get("status")), IntentStatus.PROCESSING)
        amount = int(data.get("amount", 0))
        metadata = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}
        return PaymentIntent(
            id=str(data.get("reference", "")),
            status=status,
            amount=amount,
            currency=str(data.get("currency", "")).upper(),
            amount_received=amount if status is IntentStatus.SUCCEEDED else 0,
            charge_id=_str(data.get("id")),
            payment_method_type=_str(data.get("channel")),
            card_brand=_str(authorization.get("brand")),
            card_last4=_str(authorization.get("last4")),
            failure_code=None if status is IntentStatus.SUCCEEDED else _str(data.get("status")),
            failure_message=(
                None if status is IntentStatus.SUCCEEDED else _str(data.get("gateway_response"))
            ),
            metadata={str(k): str(v) for k, v in (metadata or {}).items()},
        )


def _str(value: Any) -> str | None:
    return None if value is None or value == "" else str(value)
