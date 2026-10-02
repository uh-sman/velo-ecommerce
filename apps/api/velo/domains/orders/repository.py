"""Order data access. Queries in, frozen records out — no rules, no HTTP."""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import exists, func, literal, or_, select, tuple_, update
from sqlalchemy.ext.asyncio import AsyncSession

from velo.domains.orders.models import (
    Fulfilment,
    FulfilmentItem,
    Order,
    OrderEvent,
    OrderItem,
    Return,
    ReturnItem,
)


@dataclass(frozen=True, slots=True)
class OrderRecord:
    id: uuid.UUID
    order_number: str
    user_id: uuid.UUID | None
    email: str
    checkout_session_id: uuid.UUID | None
    status: str
    payment_status: str
    fulfilment_status: str
    currency: str
    subtotal_amount: int
    discount_amount: int
    shipping_amount: int
    tax_amount: int
    total_amount: int
    refunded_amount: int
    shipping_address: dict[str, Any]
    billing_address: dict[str, Any]
    discount_code: str | None
    metadata: dict[str, Any]
    placed_at: datetime
    customer_note: str | None = None
    internal_note: str | None = None
    cancelled_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class OrderItemRecord:
    id: uuid.UUID
    variant_id: uuid.UUID | None
    product_title: str
    variant_title: str
    sku: str
    image_url: str | None
    unit_price_amount: int
    quantity: int
    discount_amount: int
    tax_amount: int
    total_amount: int
    tax_rate: Decimal = Decimal(0)
    quantity_fulfilled: int = 0
    quantity_returned: int = 0


@dataclass(frozen=True, slots=True)
class EventRecord:
    id: uuid.UUID
    event_type: str
    from_status: str | None
    to_status: str | None
    actor_type: str
    actor_id: uuid.UUID | None
    payload: dict[str, Any]
    created_at: datetime


@dataclass(frozen=True, slots=True)
class FulfilmentRecord:
    id: uuid.UUID
    order_id: uuid.UUID
    status: str
    carrier: str | None
    tracking_number: str | None
    tracking_url: str | None
    shipped_at: datetime | None
    delivered_at: datetime | None
    created_at: datetime
    items: tuple[tuple[uuid.UUID, int], ...]  # (order_item_id, quantity)


@dataclass(frozen=True, slots=True)
class ReturnItemRecord:
    order_item_id: uuid.UUID
    quantity: int
    restock: bool
    condition: str | None


@dataclass(frozen=True, slots=True)
class ReturnRecord:
    id: uuid.UUID
    order_id: uuid.UUID
    rma_number: str
    status: str
    reason: str
    customer_note: str | None
    staff_note: str | None
    refund_amount: int | None
    created_at: datetime
    updated_at: datetime
    items: tuple[ReturnItemRecord, ...]


@dataclass(frozen=True, slots=True)
class OrderFilters:
    status: str | None = None
    payment_status: str | None = None
    fulfilment_status: str | None = None
    query: str | None = None  # order number, customer email, or SKU
    placed_from: datetime | None = None
    placed_to: datetime | None = None
    user_id: uuid.UUID | None = None


def _order(row: Order) -> OrderRecord:
    return OrderRecord(
        id=row.id,
        order_number=row.order_number,
        user_id=row.user_id,
        email=row.email,
        checkout_session_id=row.checkout_session_id,
        status=row.status,
        payment_status=row.payment_status,
        fulfilment_status=row.fulfilment_status,
        currency=row.currency,
        subtotal_amount=row.subtotal_amount,
        discount_amount=row.discount_amount,
        shipping_amount=row.shipping_amount,
        tax_amount=row.tax_amount,
        total_amount=row.total_amount,
        refunded_amount=row.refunded_amount,
        shipping_address=dict(row.shipping_address),
        billing_address=dict(row.billing_address),
        discount_code=row.discount_code,
        metadata=dict(row.metadata_),
        placed_at=row.placed_at,
        customer_note=row.customer_note,
        internal_note=row.internal_note,
        cancelled_at=row.cancelled_at,
    )


def _item(row: OrderItem) -> OrderItemRecord:
    return OrderItemRecord(
        id=row.id,
        variant_id=row.variant_id,
        product_title=row.product_title,
        variant_title=row.variant_title,
        sku=row.sku,
        image_url=row.image_url,
        unit_price_amount=row.unit_price_amount,
        quantity=row.quantity,
        discount_amount=row.discount_amount,
        tax_amount=row.tax_amount,
        total_amount=row.total_amount,
        tax_rate=row.tax_rate,
        quantity_fulfilled=row.quantity_fulfilled,
        quantity_returned=row.quantity_returned,
    )


class OrderRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    # ── Orders ────────────────────────────────────────────────────────────

    async def number_taken(self, number: str) -> bool:
        return (
            await self._session.scalar(select(Order.id).where(Order.order_number == number))
        ) is not None

    async def create(self, order_id: uuid.UUID, **fields: Any) -> OrderRecord:
        metadata = fields.pop("metadata", {})
        row = Order(id=order_id, metadata_=metadata, **fields)
        self._session.add(row)
        await self._session.flush()
        return _order(row)

    async def add_item(self, order_id: uuid.UUID, **fields: Any) -> None:
        self._session.add(OrderItem(order_id=order_id, **fields))

    async def add_event(self, order_id: uuid.UUID, **fields: Any) -> None:
        self._session.add(OrderEvent(order_id=order_id, **fields))

    async def flush(self) -> None:
        await self._session.flush()

    async def get(self, order_id: uuid.UUID, *, lock: bool = False) -> OrderRecord | None:
        query = select(Order).where(Order.id == order_id)
        if lock:
            query = query.with_for_update()
        row = await self._session.scalar(query.execution_options(populate_existing=True))
        return _order(row) if row else None

    async def by_checkout(self, session_id: uuid.UUID) -> OrderRecord | None:
        row = await self._session.scalar(
            select(Order)
            .where(Order.checkout_session_id == session_id)
            .execution_options(populate_existing=True)
        )
        return _order(row) if row else None

    async def by_number(self, number: str) -> OrderRecord | None:
        row = await self._session.scalar(
            select(Order)
            .where(Order.order_number == number.upper())
            .execution_options(populate_existing=True)
        )
        return _order(row) if row else None

    async def update(self, order_id: uuid.UUID, **fields: Any) -> OrderRecord:
        if "metadata" in fields:
            fields["metadata_"] = fields.pop("metadata")
        row = await self._session.scalar(
            update(Order)
            .where(Order.id == order_id)
            .values(**fields, updated_at=func.now())
            .returning(Order)
            .execution_options(populate_existing=True)
        )
        if row is None:  # pragma: no cover — callers lock the row first
            raise LookupError(order_id)
        return _order(row)

    async def search(
        self,
        filters: OrderFilters,
        *,
        limit: int,
        after: tuple[datetime, uuid.UUID] | None,
        count: bool = False,
    ) -> tuple[list[OrderRecord], bool, int | None]:
        """Newest first. ``query`` matches an order number, an email, or a SKU on any line."""
        conditions: list[Any] = []
        if filters.status:
            conditions.append(Order.status == filters.status)
        if filters.payment_status:
            conditions.append(Order.payment_status == filters.payment_status)
        if filters.fulfilment_status:
            conditions.append(Order.fulfilment_status == filters.fulfilment_status)
        if filters.placed_from:
            conditions.append(Order.placed_at >= filters.placed_from)
        if filters.placed_to:
            conditions.append(Order.placed_at < filters.placed_to)
        if filters.user_id:
            conditions.append(Order.user_id == filters.user_id)
        if filters.query:
            text = filters.query.strip()
            conditions.append(
                or_(
                    Order.order_number == text.upper(),
                    Order.email == text,  # CITEXT: case-insensitive
                    exists().where(OrderItem.order_id == Order.id, OrderItem.sku == text.upper()),
                    exists().where(OrderItem.order_id == Order.id, OrderItem.sku == text),
                )
            )
        query = select(Order).where(*conditions)
        if after is not None:
            query = query.where(
                tuple_(Order.placed_at, Order.id) < tuple_(literal(after[0]), literal(after[1]))
            )
        rows = (
            await self._session.scalars(
                query.order_by(Order.placed_at.desc(), Order.id.desc()).limit(limit + 1)
            )
        ).all()
        total = None
        if count:
            total = int(
                await self._session.scalar(
                    select(func.count()).select_from(Order).where(*conditions)
                )
                or 0
            )
        return [_order(row) for row in rows[:limit]], len(rows) > limit, total

    # ── Lines ─────────────────────────────────────────────────────────────

    async def items(self, order_id: uuid.UUID, *, lock: bool = False) -> list[OrderItemRecord]:
        query = select(OrderItem).where(OrderItem.order_id == order_id).order_by(OrderItem.id)
        if lock:
            query = query.with_for_update()
        rows = (await self._session.scalars(query.execution_options(populate_existing=True))).all()
        return [_item(row) for row in rows]

    async def update_item(self, item_id: uuid.UUID, **fields: Any) -> None:
        await self._session.execute(
            update(OrderItem).where(OrderItem.id == item_id).values(**fields)
        )

    # ── Events ────────────────────────────────────────────────────────────

    async def events(self, order_id: uuid.UUID) -> list[EventRecord]:
        rows = (
            await self._session.scalars(
                select(OrderEvent)
                .where(OrderEvent.order_id == order_id)
                .order_by(OrderEvent.created_at, OrderEvent.id)
            )
        ).all()
        return [
            EventRecord(
                id=row.id,
                event_type=row.event_type,
                from_status=row.from_status,
                to_status=row.to_status,
                actor_type=row.actor_type,
                actor_id=row.actor_id,
                payload=dict(row.payload),
                created_at=row.created_at,
            )
            for row in rows
        ]

    # ── Fulfilments ───────────────────────────────────────────────────────

    async def create_fulfilment(
        self, order_id: uuid.UUID, items: Sequence[tuple[uuid.UUID, int]], **fields: Any
    ) -> FulfilmentRecord:
        row = Fulfilment(order_id=order_id, **fields)
        self._session.add(row)
        await self._session.flush()
        for item_id, quantity in items:
            self._session.add(
                FulfilmentItem(fulfilment_id=row.id, order_item_id=item_id, quantity=quantity)
            )
        await self._session.flush()
        return self._fulfilment(row, tuple(items))

    async def fulfilment(
        self, fulfilment_id: uuid.UUID, *, lock: bool = False
    ) -> FulfilmentRecord | None:
        query = select(Fulfilment).where(Fulfilment.id == fulfilment_id)
        if lock:
            query = query.with_for_update()
        row = await self._session.scalar(query.execution_options(populate_existing=True))
        if row is None:
            return None
        return self._fulfilment(row, await self._fulfilment_items(row.id))

    async def fulfilments(self, order_id: uuid.UUID) -> list[FulfilmentRecord]:
        rows = (
            await self._session.scalars(
                select(Fulfilment)
                .where(Fulfilment.order_id == order_id)
                .order_by(Fulfilment.created_at, Fulfilment.id)
                .execution_options(populate_existing=True)
            )
        ).all()
        return [self._fulfilment(row, await self._fulfilment_items(row.id)) for row in rows]

    async def fulfilments_by_tracking(self, tracking_number: str) -> list[FulfilmentRecord]:
        rows = (
            await self._session.scalars(
                select(Fulfilment).where(Fulfilment.tracking_number == tracking_number)
            )
        ).all()
        return [self._fulfilment(row, await self._fulfilment_items(row.id)) for row in rows]

    async def update_fulfilment(self, fulfilment_id: uuid.UUID, **fields: Any) -> None:
        await self._session.execute(
            update(Fulfilment).where(Fulfilment.id == fulfilment_id).values(**fields)
        )

    async def _fulfilment_items(
        self, fulfilment_id: uuid.UUID
    ) -> tuple[tuple[uuid.UUID, int], ...]:
        rows = await self._session.execute(
            select(FulfilmentItem.order_item_id, FulfilmentItem.quantity).where(
                FulfilmentItem.fulfilment_id == fulfilment_id
            )
        )
        return tuple((item_id, int(quantity)) for item_id, quantity in rows.all())

    @staticmethod
    def _fulfilment(row: Fulfilment, items: tuple[tuple[uuid.UUID, int], ...]) -> FulfilmentRecord:
        return FulfilmentRecord(
            id=row.id,
            order_id=row.order_id,
            status=row.status,
            carrier=row.carrier,
            tracking_number=row.tracking_number,
            tracking_url=row.tracking_url,
            shipped_at=row.shipped_at,
            delivered_at=row.delivered_at,
            created_at=row.created_at,
            items=items,
        )

    # ── Returns ───────────────────────────────────────────────────────────

    async def create_return(
        self, order_id: uuid.UUID, items: Sequence[tuple[uuid.UUID, int]], **fields: Any
    ) -> ReturnRecord:
        row = Return(order_id=order_id, **fields)
        self._session.add(row)
        await self._session.flush()
        for item_id, quantity in items:
            self._session.add(
                ReturnItem(return_id=row.id, order_item_id=item_id, quantity=quantity)
            )
        await self._session.flush()
        return await self._return(row)

    async def get_return(self, return_id: uuid.UUID, *, lock: bool = False) -> ReturnRecord | None:
        query = select(Return).where(Return.id == return_id)
        if lock:
            query = query.with_for_update()
        row = await self._session.scalar(query.execution_options(populate_existing=True))
        return await self._return(row) if row else None

    async def returns_for(self, order_id: uuid.UUID) -> list[ReturnRecord]:
        rows = (
            await self._session.scalars(
                select(Return)
                .where(Return.order_id == order_id)
                .order_by(Return.created_at, Return.id)
                .execution_options(populate_existing=True)
            )
        ).all()
        return [await self._return(row) for row in rows]

    async def list_returns(
        self,
        *,
        status: str | None,
        limit: int,
        after: tuple[datetime, uuid.UUID] | None,
    ) -> tuple[list[ReturnRecord], bool]:
        query = select(Return)
        if status:
            query = query.where(Return.status == status)
        if after is not None:
            query = query.where(
                tuple_(Return.created_at, Return.id) < tuple_(literal(after[0]), literal(after[1]))
            )
        rows = (
            await self._session.scalars(
                query.order_by(Return.created_at.desc(), Return.id.desc()).limit(limit + 1)
            )
        ).all()
        return [await self._return(row) for row in rows[:limit]], len(rows) > limit

    async def update_return(self, return_id: uuid.UUID, **fields: Any) -> None:
        await self._session.execute(
            update(Return).where(Return.id == return_id).values(**fields, updated_at=func.now())
        )

    async def update_return_item(
        self, return_id: uuid.UUID, order_item_id: uuid.UUID, **fields: Any
    ) -> None:
        await self._session.execute(
            update(ReturnItem)
            .where(ReturnItem.return_id == return_id, ReturnItem.order_item_id == order_item_id)
            .values(**fields)
        )

    async def rma_taken(self, rma: str) -> bool:
        return (
            await self._session.scalar(select(Return.id).where(Return.rma_number == rma))
        ) is not None

    async def _return(self, row: Return) -> ReturnRecord:
        items = (
            await self._session.scalars(
                select(ReturnItem)
                .where(ReturnItem.return_id == row.id)
                .execution_options(populate_existing=True)
            )
        ).all()
        return ReturnRecord(
            id=row.id,
            order_id=row.order_id,
            rma_number=row.rma_number,
            status=row.status,
            reason=row.reason,
            customer_note=row.customer_note,
            staff_note=row.staff_note,
            refund_amount=row.refund_amount,
            created_at=row.created_at,
            updated_at=row.updated_at,
            items=tuple(
                ReturnItemRecord(
                    order_item_id=item.order_item_id,
                    quantity=item.quantity,
                    restock=item.restock,
                    condition=item.condition,
                )
                for item in items
            ),
        )
