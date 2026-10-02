"""Payment data access. Queries in, frozen records out — no rules, no HTTP.

``checkout_sessions`` is named as a bare table clause, read-only, for the one
query that needs a checkout's status (ARCHITECTURE.md §3, rule 5).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import column, delete, func, select, table, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from velo.domains.payments.models import (
    IdempotencyKey,
    Payment,
    PaymentEvent,
    Refund,
    RefundItem,
)

UNSETTLED = ("pending", "processing", "requires_action")
# Refunds that count against the capture: issued, or on their way.
COMMITTED_REFUNDS = ("pending", "succeeded")
_checkouts = table("checkout_sessions", column("id"), column("status"))


@dataclass(frozen=True, slots=True)
class PaymentRecord:
    id: uuid.UUID
    order_id: uuid.UUID | None
    checkout_session_id: uuid.UUID
    provider: str
    provider_intent_id: str | None
    provider_charge_id: str | None
    status: str
    amount: int
    currency: str
    amount_captured: int
    amount_refunded: int
    payment_method_type: str | None
    card_brand: str | None
    card_last4: str | None
    failure_code: str | None
    failure_message: str | None
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class EventRecord:
    id: uuid.UUID
    payment_id: uuid.UUID | None
    provider: str
    provider_event_id: str
    event_type: str
    payload: dict[str, Any]
    processed_at: datetime | None
    processing_error: str | None
    attempts: int
    dead_lettered_at: datetime | None
    received_at: datetime


@dataclass(frozen=True, slots=True)
class RefundItemRecord:
    order_item_id: uuid.UUID
    quantity: int
    amount: int
    restock: bool


@dataclass(frozen=True, slots=True)
class RefundRecord:
    id: uuid.UUID
    payment_id: uuid.UUID
    order_id: uuid.UUID
    return_id: uuid.UUID | None
    provider_refund_id: str | None
    amount: int
    currency: str
    reason: str
    status: str
    actor_id: uuid.UUID | None
    note: str | None
    submitted_at: datetime | None
    attempts: int
    last_error: str | None
    created_at: datetime
    items: tuple[RefundItemRecord, ...] = ()


@dataclass(frozen=True, slots=True)
class IdempotencyRecord:
    key: uuid.UUID
    user_id: uuid.UUID | None
    endpoint: str
    request_hash: str
    status: str
    response_status: int | None
    response_body: dict[str, Any] | None


def _payment(row: Payment) -> PaymentRecord:
    return PaymentRecord(
        id=row.id,
        order_id=row.order_id,
        checkout_session_id=row.checkout_session_id,
        provider=row.provider,
        provider_intent_id=row.provider_intent_id,
        provider_charge_id=row.provider_charge_id,
        status=row.status,
        amount=row.amount,
        currency=row.currency,
        amount_captured=row.amount_captured,
        amount_refunded=row.amount_refunded,
        payment_method_type=row.payment_method_type,
        card_brand=row.card_brand,
        card_last4=row.card_last4,
        failure_code=row.failure_code,
        failure_message=row.failure_message,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _event(row: PaymentEvent) -> EventRecord:
    return EventRecord(
        id=row.id,
        payment_id=row.payment_id,
        provider=row.provider,
        provider_event_id=row.provider_event_id,
        event_type=row.event_type,
        payload=dict(row.payload),
        processed_at=row.processed_at,
        processing_error=row.processing_error,
        attempts=row.attempts,
        dead_lettered_at=row.dead_lettered_at,
        received_at=row.received_at,
    )


class PaymentRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    # ── Payments ──────────────────────────────────────────────────────────

    async def create(self, **fields: Any) -> PaymentRecord:
        row = Payment(**fields)
        self._session.add(row)
        await self._session.flush()
        return _payment(row)

    async def get(self, payment_id: uuid.UUID, *, lock: bool = False) -> PaymentRecord | None:
        query = select(Payment).where(Payment.id == payment_id)
        if lock:
            query = query.with_for_update()
        row = await self._session.scalar(query.execution_options(populate_existing=True))
        return _payment(row) if row else None

    async def by_intent(
        self, provider: str, intent_id: str, *, lock: bool = False
    ) -> PaymentRecord | None:
        query = select(Payment).where(
            Payment.provider == provider, Payment.provider_intent_id == intent_id
        )
        if lock:
            query = query.with_for_update()
        row = await self._session.scalar(query.execution_options(populate_existing=True))
        return _payment(row) if row else None

    async def latest_for_session(self, session_id: uuid.UUID) -> PaymentRecord | None:
        row = await self._session.scalar(
            select(Payment)
            .where(Payment.checkout_session_id == session_id)
            .order_by(Payment.created_at.desc(), Payment.id.desc())
            .limit(1)
            .execution_options(populate_existing=True)
        )
        return _payment(row) if row else None

    async def update(self, payment_id: uuid.UUID, **fields: Any) -> PaymentRecord:
        row = await self._session.scalar(
            update(Payment)
            .where(Payment.id == payment_id)
            .values(**fields, updated_at=func.now())
            .returning(Payment)
            .execution_options(populate_existing=True)
        )
        if row is None:  # pragma: no cover — callers lock the row first
            raise LookupError(payment_id)
        return _payment(row)

    async def unsettled_before(self, cutoff: datetime, limit: int) -> list[uuid.UUID]:
        """Reconciliation's sweep, on the partial index ``idx_payments_pending``."""
        rows = await self._session.scalars(
            select(Payment.id)
            .where(Payment.status.in_(UNSETTLED), Payment.created_at < cutoff)
            .order_by(Payment.created_at)
            .limit(limit)
        )
        return list(rows.all())

    async def failed_on_closed_checkouts(self, cutoff: datetime, limit: int) -> list[uuid.UUID]:
        """Declined intents whose checkout has ended. Still payable at the provider: cancel them."""
        rows = await self._session.scalars(
            select(Payment.id)
            .join(_checkouts, _checkouts.c.id == Payment.checkout_session_id)
            .where(
                Payment.status == "failed",
                Payment.provider_intent_id.is_not(None),
                Payment.updated_at < cutoff,
                _checkouts.c.status.in_(("expired", "abandoned")),
            )
            .order_by(Payment.updated_at)
            .limit(limit)
        )
        return list(rows.all())

    # ── Webhook events ────────────────────────────────────────────────────

    async def record_event(
        self,
        *,
        provider: str,
        provider_event_id: str,
        event_type: str,
        payload: dict[str, Any],
        payment_id: uuid.UUID | None,
    ) -> uuid.UUID | None:
        """Store an event; ``None`` if this provider event id was already stored."""
        event_id: uuid.UUID | None = await self._session.scalar(
            insert(PaymentEvent)
            .values(
                provider=provider,
                provider_event_id=provider_event_id,
                event_type=event_type,
                payload=payload,
                payment_id=payment_id,
                signature_verified=True,
            )
            .on_conflict_do_nothing(index_elements=["provider", "provider_event_id"])
            .returning(PaymentEvent.id)
        )
        return event_id

    async def event(self, event_id: uuid.UUID, *, claim: bool = False) -> EventRecord | None:
        """With ``claim``, locked — or ``None`` while another worker holds it."""
        query = select(PaymentEvent).where(PaymentEvent.id == event_id)
        if claim:
            query = query.with_for_update(skip_locked=True)
        row = await self._session.scalar(query.execution_options(populate_existing=True))
        return _event(row) if row else None

    async def update_event(self, event_id: uuid.UUID, **fields: Any) -> None:
        await self._session.execute(
            update(PaymentEvent).where(PaymentEvent.id == event_id).values(**fields)
        )

    async def due_events(self, now: datetime, limit: int) -> list[uuid.UUID]:
        rows = await self._session.scalars(
            select(PaymentEvent.id)
            .where(
                PaymentEvent.processed_at.is_(None),
                PaymentEvent.dead_lettered_at.is_(None),
                (PaymentEvent.next_attempt_at.is_(None)) | (PaymentEvent.next_attempt_at <= now),
            )
            .order_by(PaymentEvent.received_at)
            .limit(limit)
        )
        return list(rows.all())

    async def dead_events(self, limit: int = 500) -> list[EventRecord]:
        rows = await self._session.scalars(
            select(PaymentEvent)
            .where(PaymentEvent.dead_lettered_at.is_not(None))
            .order_by(PaymentEvent.dead_lettered_at)
            .limit(limit)
        )
        return [_event(row) for row in rows.all()]

    # ── Refunds ───────────────────────────────────────────────────────────

    async def add_refund(self, **fields: Any) -> bool:
        """Record a refund the provider reported; False if its provider id is already recorded.

        Reported refunds already exist at the provider, so they are marked
        submitted: the retry of unsubmitted refunds must never send one again.
        """
        fields.setdefault("submitted_at", func.now())
        inserted = await self._session.scalar(
            insert(Refund)
            .values(**fields)
            .on_conflict_do_nothing(index_elements=["provider_refund_id"])
            .returning(Refund.id)
        )
        return inserted is not None

    async def refunded_total(self, payment_id: uuid.UUID) -> int:
        total = await self._session.scalar(
            select(func.coalesce(func.sum(Refund.amount), 0)).where(
                Refund.payment_id == payment_id, Refund.status == "succeeded"
            )
        )
        return int(total or 0)

    async def committed_refund_total(self, payment_id: uuid.UUID) -> int:
        """Succeeded plus in-flight: what the capture ceiling is measured against."""
        total = await self._session.scalar(
            select(func.coalesce(func.sum(Refund.amount), 0)).where(
                Refund.payment_id == payment_id, Refund.status.in_(COMMITTED_REFUNDS)
            )
        )
        return int(total or 0)

    async def settled_payment_for_order(
        self, order_id: uuid.UUID, *, lock: bool = False
    ) -> PaymentRecord | None:
        """The payment that paid for the order: the one with money captured."""
        query = (
            select(Payment)
            .where(Payment.order_id == order_id, Payment.amount_captured > 0)
            .order_by(Payment.created_at)
            .limit(1)
        )
        if lock:
            query = query.with_for_update()
        row = await self._session.scalar(query.execution_options(populate_existing=True))
        return _payment(row) if row else None

    async def payments_for_order(self, order_id: uuid.UUID) -> list[PaymentRecord]:
        rows = (
            await self._session.scalars(
                select(Payment).where(Payment.order_id == order_id).order_by(Payment.created_at)
            )
        ).all()
        return [_payment(row) for row in rows]

    async def create_refund(
        self, items: list[tuple[uuid.UUID, int, int, bool]], **fields: Any
    ) -> RefundRecord:
        """A refund and its lines ``(order_item_id, quantity, amount, restock)``."""
        row = Refund(**fields)
        self._session.add(row)
        await self._session.flush()
        for item_id, quantity, amount, restock in items:
            self._session.add(
                RefundItem(
                    refund_id=row.id,
                    order_item_id=item_id,
                    quantity=quantity,
                    amount=amount,
                    restock=restock,
                )
            )
        await self._session.flush()
        return await self._refund(row)

    async def refund(self, refund_id: uuid.UUID, *, lock: bool = False) -> RefundRecord | None:
        query = select(Refund).where(Refund.id == refund_id)
        if lock:
            query = query.with_for_update()
        row = await self._session.scalar(query.execution_options(populate_existing=True))
        return await self._refund(row) if row else None

    async def refund_by_provider_id(self, provider_refund_id: str) -> RefundRecord | None:
        row = await self._session.scalar(
            select(Refund)
            .where(Refund.provider_refund_id == provider_refund_id)
            .execution_options(populate_existing=True)
        )
        return await self._refund(row) if row else None

    async def refunds_for_order(self, order_id: uuid.UUID) -> list[RefundRecord]:
        rows = (
            await self._session.scalars(
                select(Refund)
                .where(Refund.order_id == order_id)
                .order_by(Refund.created_at, Refund.id)
                .execution_options(populate_existing=True)
            )
        ).all()
        return [await self._refund(row) for row in rows]

    async def refunded_units(self, order_id: uuid.UUID) -> dict[uuid.UUID, tuple[int, int]]:
        """Per order line: ``(units refunded, of which removed from the order)``.

        Refunded or on the way. A unit refunded *with restock* before it shipped
        is taken off the order: it will not be fulfilled.
        """
        rows = await self._session.execute(
            select(
                RefundItem.order_item_id,
                func.sum(RefundItem.quantity),
                func.coalesce(
                    func.sum(RefundItem.quantity).filter(RefundItem.restock.is_(True)), 0
                ),
            )
            .join(Refund, Refund.id == RefundItem.refund_id)
            .where(Refund.order_id == order_id, Refund.status.in_(COMMITTED_REFUNDS))
            .group_by(RefundItem.order_item_id)
        )
        return {
            item_id: (int(total or 0), int(removed or 0)) for item_id, total, removed in rows.all()
        }

    async def extra_refunded(self, order_id: uuid.UUID) -> int:
        """Refunded beyond any line: shipping, and goodwill amounts."""
        line_amounts = (
            select(
                RefundItem.refund_id.label("refund_id"),
                func.sum(RefundItem.amount).label("lines"),
            )
            .group_by(RefundItem.refund_id)
            .subquery()
        )
        total = await self._session.scalar(
            select(
                func.coalesce(func.sum(Refund.amount - func.coalesce(line_amounts.c.lines, 0)), 0)
            )
            .select_from(Refund)
            .outerjoin(line_amounts, line_amounts.c.refund_id == Refund.id)
            .where(Refund.order_id == order_id, Refund.status.in_(COMMITTED_REFUNDS))
        )
        return int(total or 0)

    async def update_refund(self, refund_id: uuid.UUID, **fields: Any) -> None:
        await self._session.execute(update(Refund).where(Refund.id == refund_id).values(**fields))

    async def pending_submitted_refunds(self, payment_id: uuid.UUID) -> list[tuple[uuid.UUID, int]]:
        rows = await self._session.execute(
            select(Refund.id, Refund.amount)
            .where(
                Refund.payment_id == payment_id,
                Refund.status == "pending",
                Refund.submitted_at.is_not(None),
            )
            .order_by(Refund.created_at, Refund.id)
        )
        return [(refund_id, int(amount)) for refund_id, amount in rows.all()]

    async def unsubmitted_refunds(self, cutoff: datetime, limit: int) -> list[uuid.UUID]:
        rows = await self._session.scalars(
            select(Refund.id)
            .where(
                Refund.status == "pending",
                Refund.submitted_at.is_(None),
                Refund.created_at < cutoff,
            )
            .order_by(Refund.created_at)
            .limit(limit)
        )
        return list(rows.all())

    async def _refund(self, row: Refund) -> RefundRecord:
        items = (
            await self._session.scalars(select(RefundItem).where(RefundItem.refund_id == row.id))
        ).all()
        return RefundRecord(
            id=row.id,
            payment_id=row.payment_id,
            order_id=row.order_id,
            return_id=row.return_id,
            provider_refund_id=row.provider_refund_id,
            amount=row.amount,
            currency=row.currency,
            reason=row.reason,
            status=row.status,
            actor_id=row.actor_id,
            note=row.note,
            submitted_at=row.submitted_at,
            attempts=row.attempts,
            last_error=row.last_error,
            created_at=row.created_at,
            items=tuple(
                RefundItemRecord(
                    order_item_id=item.order_item_id,
                    quantity=item.quantity,
                    amount=item.amount,
                    restock=item.restock,
                )
                for item in items
            ),
        )

    # ── Idempotency keys ──────────────────────────────────────────────────

    async def claim_key(
        self, key: uuid.UUID, *, user_id: uuid.UUID | None, endpoint: str, request_hash: str
    ) -> bool:
        """Insert the ``in_flight`` row. True if this request now owns the key.

        The primary key makes this the lock: of two concurrent requests with one
        key, exactly one insert succeeds (PAYMENTS-AND-CHECKOUT.md §5).
        """
        await self._session.execute(
            delete(IdempotencyKey).where(
                IdempotencyKey.key == key, IdempotencyKey.expires_at < func.now()
            )
        )
        inserted = await self._session.scalar(
            insert(IdempotencyKey)
            .values(key=key, user_id=user_id, endpoint=endpoint, request_hash=request_hash)
            .on_conflict_do_nothing(index_elements=["key"])
            .returning(IdempotencyKey.key)
        )
        return inserted is not None

    async def retry_key(self, key: uuid.UUID, request_hash: str) -> bool:
        """Take back a key whose request failed, so the same request can run again."""
        taken = await self._session.scalar(
            update(IdempotencyKey)
            .where(
                IdempotencyKey.key == key,
                IdempotencyKey.status == "failed",
                IdempotencyKey.request_hash == request_hash,
            )
            .values(status="in_flight")
            .returning(IdempotencyKey.key)
        )
        return taken is not None

    async def key(self, key: uuid.UUID) -> IdempotencyRecord | None:
        row = await self._session.scalar(
            select(IdempotencyKey)
            .where(IdempotencyKey.key == key)
            .execution_options(populate_existing=True)
        )
        if row is None:
            return None
        return IdempotencyRecord(
            key=row.key,
            user_id=row.user_id,
            endpoint=row.endpoint,
            request_hash=row.request_hash,
            status=row.status,
            response_status=row.response_status,
            response_body=row.response_body,
        )

    async def finish_key(
        self,
        key: uuid.UUID,
        *,
        status: str,
        response_status: int | None = None,
        response_body: dict[str, Any] | None = None,
    ) -> None:
        await self._session.execute(
            update(IdempotencyKey)
            .where(IdempotencyKey.key == key)
            .values(status=status, response_status=response_status, response_body=response_body)
        )

    async def delete_expired_keys(self) -> int:
        result = await self._session.execute(
            delete(IdempotencyKey).where(IdempotencyKey.expires_at < func.now())
        )
        return int(result.rowcount or 0)  # type: ignore[attr-defined]
