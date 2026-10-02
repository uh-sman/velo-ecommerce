"""Checkout data access. Queries in, frozen records out — no rules, no HTTP."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from velo.domains.checkout.models import CheckoutSession


@dataclass(frozen=True, slots=True)
class SessionRecord:
    id: uuid.UUID
    cart_id: uuid.UUID
    user_id: uuid.UUID | None
    email: str
    status: str
    shipping_address_id: uuid.UUID | None
    billing_address_id: uuid.UUID | None
    shipping_rate_id: uuid.UUID | None
    discount_id: uuid.UUID | None
    currency: str
    subtotal_amount: int
    discount_amount: int
    shipping_amount: int
    tax_amount: int
    total_amount: int
    snapshot: dict[str, Any]
    expires_at: datetime
    created_at: datetime
    updated_at: datetime


def _record(row: CheckoutSession) -> SessionRecord:
    return SessionRecord(
        id=row.id,
        cart_id=row.cart_id,
        user_id=row.user_id,
        email=row.email,
        status=row.status,
        shipping_address_id=row.shipping_address_id,
        billing_address_id=row.billing_address_id,
        shipping_rate_id=row.shipping_rate_id,
        discount_id=row.discount_id,
        currency=row.currency,
        subtotal_amount=row.subtotal_amount,
        discount_amount=row.discount_amount,
        shipping_amount=row.shipping_amount,
        tax_amount=row.tax_amount,
        total_amount=row.total_amount,
        snapshot=dict(row.snapshot),
        expires_at=row.expires_at,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


class CheckoutRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def create(self, session_id: uuid.UUID, **fields: Any) -> SessionRecord:
        row = CheckoutSession(id=session_id, **fields)
        self._session.add(row)
        await self._session.flush()
        return _record(row)

    async def get(self, session_id: uuid.UUID, *, lock: bool = False) -> SessionRecord | None:
        query = select(CheckoutSession).where(CheckoutSession.id == session_id)
        if lock:
            query = query.with_for_update()
        row = await self._session.scalar(query.execution_options(populate_existing=True))
        return _record(row) if row else None

    async def update(self, session_id: uuid.UUID, **fields: Any) -> SessionRecord:
        row = await self._session.scalar(
            update(CheckoutSession)
            .where(CheckoutSession.id == session_id)
            .values(**fields, updated_at=func.now())
            .returning(CheckoutSession)
            .execution_options(populate_existing=True)
        )
        if row is None:  # pragma: no cover — callers lock the row first
            raise LookupError(session_id)
        return _record(row)

    async def for_cart(self, cart_id: uuid.UUID, statuses: tuple[str, ...]) -> list[SessionRecord]:
        rows = (
            await self._session.scalars(
                select(CheckoutSession)
                .where(CheckoutSession.cart_id == cart_id, CheckoutSession.status.in_(statuses))
                .order_by(CheckoutSession.id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        ).all()
        return [_record(row) for row in rows]

    async def expired(
        self, now: datetime, statuses: tuple[str, ...], limit: int
    ) -> list[uuid.UUID]:
        rows = await self._session.scalars(
            select(CheckoutSession.id)
            .where(CheckoutSession.status.in_(statuses), CheckoutSession.expires_at < now)
            .order_by(CheckoutSession.expires_at)
            .limit(limit)
        )
        return list(rows.all())
