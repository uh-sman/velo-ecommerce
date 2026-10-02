"""Payments: the payment ledger, webhook intake, and idempotency.

**A payment is written before the provider is called** (PAYMENTS-AND-CHECKOUT.md
§3). Its id is the idempotency key sent to the provider, so if the process
dies mid-call, a retry — or reconciliation — finds the same intent rather than
making a second one.

**Webhooks: verify, deduplicate, acknowledge** (§6.1). The router verifies the
signature over the raw body; :meth:`PaymentService.record_webhook` stores the
event under ``UNIQUE (provider, provider_event_id)``, so a duplicate delivery is
recognised by the database and dropped. Processing happens afterwards, in the
worker, with retries and a dead-letter queue (§6.4).

**Idempotency** (§5). :class:`IdempotencyService` stores a request's
fingerprint and its response. The ``in_flight`` insert is the lock — committed
before the work starts, so a concurrent request with the same key sees it.
A replay returns the stored response; a failure frees the key for a retry.
"""

from __future__ import annotations

import hashlib
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from velo.core.logging import get_logger
from velo.domains.payments.exceptions import IdempotencyKeyReusedError, RequestInProgressError
from velo.domains.payments.provider import PaymentIntent, WebhookEvent
from velo.domains.payments.repository import EventRecord, PaymentRecord, PaymentRepository

logger = get_logger(__name__)

# Webhook processing: five attempts with exponential backoff, then the
# dead-letter queue and a human (§6.4).
MAX_EVENT_ATTEMPTS = 5
EVENT_BACKOFF = timedelta(seconds=30)


class PaymentService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._payments = PaymentRepository(session)

    # ── The ledger ────────────────────────────────────────────────────────

    async def create_pending(
        self, *, session_id: uuid.UUID, provider: str, amount: int, currency: str
    ) -> PaymentRecord:
        return await self._payments.create(
            checkout_session_id=session_id,
            provider=provider,
            amount=amount,
            currency=currency,
            status="pending",
        )

    async def get(self, payment_id: uuid.UUID, *, lock: bool = False) -> PaymentRecord | None:
        return await self._payments.get(payment_id, lock=lock)

    async def find(
        self, provider: str, intent_id: str | None, payment_ref: str | None, *, lock: bool = False
    ) -> PaymentRecord | None:
        """By intent id, or by our own id from the intent's metadata.

        The second covers a crash between the provider creating an intent and
        us storing its id: the intent still names our payment.
        """
        if intent_id:
            found = await self._payments.by_intent(provider, intent_id, lock=lock)
            if found is not None:
                return found
        if payment_ref:
            try:
                payment_id = uuid.UUID(payment_ref)
            except ValueError:
                return None
            found = await self._payments.get(payment_id, lock=lock)
            if found is not None and found.provider == provider:
                return found
        return None

    async def latest_for_session(self, session_id: uuid.UUID) -> PaymentRecord | None:
        return await self._payments.latest_for_session(session_id)

    async def attach_intent(self, payment_id: uuid.UUID, intent: PaymentIntent) -> PaymentRecord:
        return await self._payments.update(payment_id, provider_intent_id=intent.id)

    async def update(self, payment_id: uuid.UUID, **fields: Any) -> PaymentRecord:
        return await self._payments.update(payment_id, **fields)

    async def apply_intent(
        self, payment_id: uuid.UUID, intent: PaymentIntent, status: str, **fields: Any
    ) -> PaymentRecord:
        """Record what the provider says about an intent. Card details are display-only."""
        values: dict[str, Any] = {"status": status, **fields}
        if intent.id:
            values["provider_intent_id"] = intent.id
        for column, value in (
            ("provider_charge_id", intent.charge_id),
            ("payment_method_type", intent.payment_method_type),
            ("card_brand", intent.card_brand),
            ("card_last4", (intent.card_last4 or "")[-4:] or None),
        ):
            if value:
                values[column] = value
        if status == "failed" or intent.failure_code:
            values["failure_code"] = intent.failure_code
            values["failure_message"] = intent.failure_message
        return await self._payments.update(payment_id, **values)

    async def unsettled_before(self, cutoff: datetime, limit: int = 200) -> list[uuid.UUID]:
        return await self._payments.unsettled_before(cutoff, limit)

    async def failed_on_closed_checkouts(
        self, cutoff: datetime, limit: int = 200
    ) -> list[uuid.UUID]:
        return await self._payments.failed_on_closed_checkouts(cutoff, limit)

    # ── Refunds ───────────────────────────────────────────────────────────

    async def add_refund(self, **fields: Any) -> bool:
        return await self._payments.add_refund(**fields)

    async def refunded_total(self, payment_id: uuid.UUID) -> int:
        return await self._payments.refunded_total(payment_id)

    async def absorb_pending_refunds(self, payment_id: uuid.UUID, amount: int) -> int:
        """Mark our submitted, pending refunds succeeded, oldest first, up to ``amount``.

        Returns what is left unexplained by them.
        """
        for refund_id, refund_amount in await self._payments.pending_submitted_refunds(payment_id):
            if refund_amount > amount:
                break
            await self._payments.update_refund(refund_id, status="succeeded")
            amount -= refund_amount
        return amount

    async def settle_refund(self, provider_refund_id: str, status: str) -> None:
        """Record the provider's final word on a refund we issued."""
        refund = await self._payments.refund_by_provider_id(provider_refund_id)
        if refund is None or refund.status == status:
            return
        if status in ("succeeded", "failed", "cancelled"):
            await self._payments.update_refund(refund.id, status=status)

    # ── Webhook intake and processing bookkeeping ─────────────────────────

    async def record_webhook(self, provider: str, event: WebhookEvent) -> uuid.UUID | None:
        """Store a verified event and commit. ``None``: a duplicate, already stored."""
        payment = await self.find(provider, event.intent_id, event.payment_ref)
        event_id = await self._payments.record_event(
            provider=provider,
            provider_event_id=event.id,
            event_type=event.type,
            payload=event.payload,
            payment_id=payment.id if payment else None,
        )
        await self._session.commit()
        return event_id

    async def claim_event(self, event_id: uuid.UUID) -> EventRecord | None:
        return await self._payments.event(event_id, claim=True)

    async def event(self, event_id: uuid.UUID) -> EventRecord | None:
        return await self._payments.event(event_id)

    async def mark_processed(self, event_id: uuid.UUID, payment_id: uuid.UUID | None) -> None:
        fields: dict[str, Any] = {"processed_at": _now(), "processing_error": None}
        if payment_id is not None:
            fields["payment_id"] = payment_id
        await self._payments.update_event(event_id, **fields)

    async def mark_event_failed(self, event: EventRecord, error: str, now: datetime) -> bool:
        """Count a failed attempt. True if the event is now dead-lettered."""
        attempts = event.attempts + 1
        dead = attempts >= MAX_EVENT_ATTEMPTS
        await self._payments.update_event(
            event.id,
            attempts=attempts,
            processing_error=error[:2000],
            next_attempt_at=None if dead else now + EVENT_BACKOFF * 2 ** (attempts - 1),
            dead_lettered_at=now if dead else None,
        )
        return dead

    async def due_events(self, now: datetime, limit: int = 100) -> list[uuid.UUID]:
        return await self._payments.due_events(now, limit)

    async def dead_events(self) -> list[EventRecord]:
        return await self._payments.dead_events()

    async def requeue(self, event_id: uuid.UUID) -> None:
        """The replay tool: give a dead-lettered event a fresh set of attempts."""
        await self._payments.update_event(
            event_id, attempts=0, next_attempt_at=None, dead_lettered_at=None
        )

    async def delete_expired_keys(self) -> int:
        return await self._payments.delete_expired_keys()


def _now() -> datetime:
    return datetime.now(UTC)


# ── Idempotency ───────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class StoredResponse:
    status: int
    body: dict[str, Any]
    replayed: bool


def request_fingerprint(method: str, path: str, body: bytes) -> str:
    """What makes two requests "the same": the method, the path, the exact body."""
    digest = hashlib.sha256()
    for part in (method.upper().encode(), path.encode(), body):
        digest.update(len(part).to_bytes(8, "big"))
        digest.update(part)
    return digest.hexdigest()


class IdempotencyService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._keys = PaymentRepository(session)

    async def run(
        self,
        key: uuid.UUID,
        *,
        user_id: uuid.UUID | None,
        endpoint: str,
        request_hash: str,
        work: Callable[[], Awaitable[tuple[int, dict[str, Any]]]],
    ) -> StoredResponse:
        """Run ``work`` once per key; replay its stored response for every repeat.

        ``work`` owns its transaction and commits it. If it raises, the key is
        marked failed — a retry with the same key and body runs again.
        """
        claimed = await self._keys.claim_key(
            key, user_id=user_id, endpoint=endpoint, request_hash=request_hash
        )
        if not claimed:
            existing = await self._keys.key(key)
            if existing is None:  # expired and swept between the two statements
                raise RequestInProgressError()
            if (
                existing.request_hash != request_hash
                or existing.endpoint != endpoint
                or existing.user_id != user_id
            ):
                await self._session.rollback()
                raise IdempotencyKeyReusedError(
                    "This Idempotency-Key was used for a different request. "
                    "Generate a new key for a new request."
                )
            if existing.status == "completed" and existing.response_status is not None:
                await self._session.rollback()
                return StoredResponse(
                    status=existing.response_status,
                    body=dict(existing.response_body or {}),
                    replayed=True,
                )
            if existing.status == "in_flight" or not await self._keys.retry_key(key, request_hash):
                await self._session.rollback()
                raise RequestInProgressError()
        await self._session.commit()  # the in_flight row is visible: the lock is held

        try:
            status, body = await work()
        except BaseException:
            await self._session.rollback()
            await self._keys.finish_key(key, status="failed")
            await self._session.commit()
            raise
        await self._keys.finish_key(
            key, status="completed", response_status=status, response_body=body
        )
        await self._session.commit()
        logger.info("idempotent_request_completed", endpoint=endpoint, status=status)
        return StoredResponse(status=status, body=body, replayed=False)
