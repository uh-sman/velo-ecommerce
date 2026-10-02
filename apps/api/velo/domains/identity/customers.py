"""Customers as the admin sees them (PLANNING.md Phase 11): who, how much, what support knows.

Lifetime value is money kept: what paid orders came to, less what was
refunded. Pending and cancelled orders count for nothing. Order statistics
are computed in one aggregate per page, never one query per customer.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import and_, func, literal, or_, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from velo.core.errors import NotFoundError
from velo.domains.identity.models import Address, CustomerNote, User
from velo.domains.orders.models import Order
from velo.domains.platform.events import Actor, record_audit

COUNTED = ("paid", "processing", "partially_fulfilled", "fulfilled", "delivered",
           "refunded", "partially_refunded")  # fmt: skip


@dataclass(frozen=True, slots=True)
class CustomerStats:
    order_count: int
    lifetime_value: int  # minor units, net of refunds
    currency: str | None
    first_order_at: datetime | None
    last_order_at: datetime | None


@dataclass(frozen=True, slots=True)
class CustomerRow:
    id: uuid.UUID
    email: str
    first_name: str | None
    last_name: str | None
    role: str
    status: str
    marketing_opt_in: bool
    created_at: datetime
    stats: CustomerStats


@dataclass(frozen=True, slots=True)
class NoteRecord:
    id: uuid.UUID
    body: str
    author_email: str | None
    created_at: datetime


@dataclass(frozen=True, slots=True)
class CustomerDetail:
    customer: CustomerRow
    phone: str | None
    email_verified: bool
    addresses: list[dict[str, Any]]
    recent_orders: list[dict[str, Any]]
    notes: list[NoteRecord]


class CustomerAdminService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def search(
        self,
        *,
        query: str | None,
        limit: int,
        after: tuple[datetime, uuid.UUID] | None,
    ) -> tuple[list[CustomerRow], bool, int]:
        conditions: list[Any] = [User.status != "deleted"]
        if query:
            like = f"%{query.strip()}%"
            conditions.append(
                or_(
                    User.email.ilike(like),
                    User.first_name.ilike(like),
                    User.last_name.ilike(like),
                    func.concat(User.first_name, " ", User.last_name).ilike(like),
                )
            )
        page = select(User).where(*conditions)
        if after is not None:
            page = page.where(
                tuple_(User.created_at, User.id) < tuple_(literal(after[0]), literal(after[1]))
            )
        users = (
            await self._session.scalars(
                page.order_by(User.created_at.desc(), User.id.desc()).limit(limit + 1)
            )
        ).all()
        total = int(
            await self._session.scalar(select(func.count()).select_from(User).where(*conditions))
            or 0
        )
        shown = list(users[:limit])
        stats = await self._stats([user.id for user in shown])
        return [self._row(user, stats.get(user.id)) for user in shown], len(users) > limit, total

    async def detail(self, user_id: uuid.UUID) -> CustomerDetail:
        user = await self._session.get(User, user_id)
        if user is None or user.status == "deleted":
            raise NotFoundError("No such customer.")
        stats = (await self._stats([user_id])).get(user_id)
        addresses = (
            await self._session.scalars(
                select(Address).where(Address.user_id == user_id).order_by(Address.created_at)
            )
        ).all()
        orders = (
            await self._session.scalars(
                select(Order)
                .where(Order.user_id == user_id)
                .order_by(Order.placed_at.desc())
                .limit(25)
            )
        ).all()
        author = User.__table__.alias("author")
        notes = (
            await self._session.execute(
                select(CustomerNote, author.c.email)
                .outerjoin(author, author.c.id == CustomerNote.author_id)
                .where(CustomerNote.user_id == user_id)
                .order_by(CustomerNote.created_at.desc())
            )
        ).all()
        return CustomerDetail(
            customer=self._row(user, stats),
            phone=user.phone,
            email_verified=user.email_verified_at is not None,
            addresses=[
                {
                    "id": str(a.id),
                    "first_name": a.first_name,
                    "last_name": a.last_name,
                    "line1": a.line1,
                    "line2": a.line2,
                    "city": a.city,
                    "region": a.region,
                    "postal_code": a.postal_code,
                    "country_code": a.country_code,
                    "is_default_shipping": a.is_default_shipping,
                }
                for a in addresses
            ],
            recent_orders=[
                {
                    "id": str(o.id),
                    "number": o.order_number,
                    "status": o.status,
                    "placed_at": o.placed_at.isoformat(),
                    "total": {"amount": o.total_amount, "currency": o.currency},
                }
                for o in orders
            ],
            notes=[
                NoteRecord(
                    id=note.id, body=note.body, author_email=email, created_at=note.created_at
                )
                for note, email in notes
            ],
        )

    async def add_note(self, user_id: uuid.UUID, body: str, actor: Actor) -> NoteRecord:
        if await self._session.get(User, user_id) is None:
            raise NotFoundError("No such customer.")
        note = CustomerNote(user_id=user_id, author_id=actor.user_id, body=body)
        self._session.add(note)
        await self._session.flush()
        record_audit(self._session, actor, "customer.note_added", "user", user_id, None)
        await self._session.commit()
        return NoteRecord(
            id=note.id, body=note.body, author_email=actor.email, created_at=note.created_at
        )

    async def _stats(self, user_ids: list[uuid.UUID]) -> dict[uuid.UUID, CustomerStats]:
        if not user_ids:
            return {}
        rows = await self._session.execute(
            select(
                Order.user_id,
                func.count(),
                func.coalesce(func.sum(Order.total_amount - Order.refunded_amount), 0),
                func.max(Order.currency),
                func.min(Order.placed_at),
                func.max(Order.placed_at),
            )
            .where(and_(Order.user_id.in_(user_ids), Order.status.in_(COUNTED)))
            .group_by(Order.user_id)
        )
        return {
            user_id: CustomerStats(
                order_count=int(count),
                lifetime_value=int(value),
                currency=currency,
                first_order_at=first,
                last_order_at=last,
            )
            for user_id, count, value, currency, first, last in rows.all()
        }

    @staticmethod
    def _row(user: User, stats: CustomerStats | None) -> CustomerRow:
        return CustomerRow(
            id=user.id,
            email=user.email,
            first_name=user.first_name,
            last_name=user.last_name,
            role=user.role,
            status=user.status,
            marketing_opt_in=user.marketing_opt_in,
            created_at=user.created_at,
            stats=stats
            or CustomerStats(
                order_count=0,
                lifetime_value=0,
                currency=None,
                first_order_at=None,
                last_order_at=None,
            ),
        )
