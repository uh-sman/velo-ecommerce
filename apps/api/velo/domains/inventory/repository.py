"""Inventory data access. Queries in, frozen records out — no rules, no HTTP.

Admin listings show each variant's SKU and title, which live in the catalog's
``product_variants`` table. It is named here as a bare table clause, read-only,
never imported as a model (ARCHITECTURE.md §3, rule 5).
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import Integer, Uuid, column, func, literal, select, table, tuple_, update, values
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from velo.domains.inventory.models import (
    BackInStockSubscription,
    InventoryItem,
    InventoryMovement,
    InventoryReservation,
)

_variants = table(
    "product_variants",
    column("id"),
    column("product_id"),
    column("sku"),
    column("title"),
    column("deleted_at"),
)
_products = table("products", column("id"), column("title"), column("slug"))


@dataclass(frozen=True, slots=True)
class StockRecord:
    variant_id: uuid.UUID
    quantity_on_hand: int
    quantity_reserved: int
    reorder_point: int
    track_inventory: bool
    allow_backorder: bool
    updated_at: datetime

    @property
    def available(self) -> int:
        """Available-to-sell. Derived, never stored (DATA-MODEL.md §5)."""
        return self.quantity_on_hand - self.quantity_reserved

    @property
    def sellable(self) -> bool:
        return not self.track_inventory or self.allow_backorder or self.available > 0


@dataclass(frozen=True, slots=True)
class StockRow:
    """A stock record with the variant it belongs to, for admin lists."""

    stock: StockRecord
    sku: str
    variant_title: str
    product_id: uuid.UUID
    product_title: str


@dataclass(frozen=True, slots=True)
class MovementRecord:
    id: uuid.UUID
    variant_id: uuid.UUID
    quantity_delta: int
    reason: str
    reference_type: str | None
    reference_id: uuid.UUID | None
    actor_id: uuid.UUID | None
    note: str | None
    created_at: datetime


@dataclass(frozen=True, slots=True)
class SubscriptionRecord:
    id: uuid.UUID
    variant_id: uuid.UUID
    email: str
    user_id: uuid.UUID | None


@dataclass(frozen=True, slots=True)
class ReservationRecord:
    id: uuid.UUID
    variant_id: uuid.UUID
    checkout_session_id: uuid.UUID
    quantity: int
    status: str
    expires_at: datetime


@dataclass(frozen=True, slots=True)
class VariantLabel:
    variant_id: uuid.UUID
    product_id: uuid.UUID
    sku: str
    variant_title: str
    product_title: str
    product_slug: str


def _stock(row: InventoryItem) -> StockRecord:
    return StockRecord(
        variant_id=row.variant_id,
        quantity_on_hand=row.quantity_on_hand,
        quantity_reserved=row.quantity_reserved,
        reorder_point=row.reorder_point,
        track_inventory=row.track_inventory,
        allow_backorder=row.allow_backorder,
        updated_at=row.updated_at,
    )


def _rows(name: str, types: Mapping[str, Any], data: Sequence[tuple[Any, ...]]) -> Any:
    """An inline ``(VALUES ...) AS name (columns)`` table, to update many rows in one statement."""
    return values(*(column(key, type_) for key, type_ in types.items()), name=name).data(list(data))


class InventoryRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def stock(self, variant_ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, StockRecord]:
        if not variant_ids:
            return {}
        rows = (
            await self._session.scalars(
                select(InventoryItem).where(InventoryItem.variant_id.in_(variant_ids))
            )
        ).all()
        return {row.variant_id: _stock(row) for row in rows}

    async def lock(self, variant_id: uuid.UUID) -> StockRecord | None:
        """The row, locked until the transaction ends, so concurrent adjustments serialise."""
        row = await self._session.scalar(
            select(InventoryItem)
            .where(InventoryItem.variant_id == variant_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return _stock(row) if row else None

    async def lock_many(self, variant_ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, StockRecord]:
        """Several rows, locked in variant order.

        A fixed lock order is what keeps two checkouts that share SKUs from
        deadlocking: each waits for the other in the same sequence.
        """
        if not variant_ids:
            return {}
        rows = (
            await self._session.scalars(
                select(InventoryItem)
                .where(InventoryItem.variant_id.in_(variant_ids))
                .order_by(InventoryItem.variant_id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        ).all()
        return {row.variant_id: _stock(row) for row in rows}

    async def create(self, variant_id: uuid.UUID, **fields: Any) -> StockRecord:
        row = InventoryItem(variant_id=variant_id, **fields)
        self._session.add(row)
        await self._session.flush()
        return _stock(row)

    async def update(self, variant_id: uuid.UUID, **fields: Any) -> StockRecord:
        row = await self._session.scalar(
            update(InventoryItem)
            .where(InventoryItem.variant_id == variant_id)
            .values(**fields, updated_at=func.now())
            .returning(InventoryItem)
            .execution_options(populate_existing=True)
        )
        if row is None:  # pragma: no cover — the service locks the row first
            raise LookupError(variant_id)
        return _stock(row)

    async def update_many(
        self, changes: Mapping[uuid.UUID, tuple[int, int]]
    ) -> dict[uuid.UUID, StockRecord]:
        """Set ``(quantity_on_hand, quantity_reserved)`` on several locked rows in one statement."""
        if not changes:
            return {}
        rows = _rows(
            "changes",
            {"variant_id": Uuid(), "on_hand": Integer(), "reserved": Integer()},
            [(variant_id, *quantities) for variant_id, quantities in changes.items()],
        )
        updated = await self._session.scalars(
            update(InventoryItem)
            .where(InventoryItem.variant_id == rows.c.variant_id)
            .values(
                quantity_on_hand=rows.c.on_hand,
                quantity_reserved=rows.c.reserved,
                updated_at=func.now(),
            )
            .returning(InventoryItem)
            .execution_options(populate_existing=True)
        )
        return {row.variant_id: _stock(row) for row in updated.all()}

    async def add_movements(self, movements: Sequence[Mapping[str, Any]]) -> None:
        """Several ledger rows in one INSERT. Nothing is read back."""
        if movements:
            await self._session.execute(insert(InventoryMovement).values(list(movements)))

    async def add_movement(self, **fields: Any) -> MovementRecord:
        row = InventoryMovement(**fields)
        self._session.add(row)
        await self._session.flush()
        return self._movement(row)

    async def movements(
        self,
        variant_id: uuid.UUID,
        *,
        limit: int,
        after: tuple[datetime, uuid.UUID] | None,
    ) -> tuple[list[MovementRecord], bool]:
        query = select(InventoryMovement).where(InventoryMovement.variant_id == variant_id)
        if after is not None:
            query = query.where(
                tuple_(InventoryMovement.created_at, InventoryMovement.id)
                < tuple_(literal(after[0]), literal(after[1]))
            )
        rows = (
            await self._session.scalars(
                query.order_by(
                    InventoryMovement.created_at.desc(), InventoryMovement.id.desc()
                ).limit(limit + 1)
            )
        ).all()
        return [self._movement(row) for row in rows[:limit]], len(rows) > limit

    async def reference_totals(
        self, reference_type: str, reference_id: uuid.UUID
    ) -> dict[uuid.UUID, int]:
        """Net movement per variant written against one reference (an order, a return)."""
        rows = await self._session.execute(
            select(InventoryMovement.variant_id, func.sum(InventoryMovement.quantity_delta))
            .where(
                InventoryMovement.reference_type == reference_type,
                InventoryMovement.reference_id == reference_id,
            )
            .group_by(InventoryMovement.variant_id)
        )
        return {variant_id: int(total or 0) for variant_id, total in rows.all()}

    async def ledger_total(self, variant_id: uuid.UUID) -> int:
        total = await self._session.scalar(
            select(func.coalesce(func.sum(InventoryMovement.quantity_delta), 0)).where(
                InventoryMovement.variant_id == variant_id
            )
        )
        return int(total or 0)

    @staticmethod
    def _movement(row: InventoryMovement) -> MovementRecord:
        return MovementRecord(
            id=row.id,
            variant_id=row.variant_id,
            quantity_delta=row.quantity_delta,
            reason=row.reason,
            reference_type=row.reference_type,
            reference_id=row.reference_id,
            actor_id=row.actor_id,
            note=row.note,
            created_at=row.created_at,
        )

    async def list_stock(
        self,
        *,
        low_stock_only: bool,
        query_text: str | None,
        limit: int,
        after: tuple[str, uuid.UUID] | None,
    ) -> tuple[list[StockRow], bool, int]:
        base = (
            select(
                InventoryItem,
                _variants.c.sku,
                _variants.c.title,
                _variants.c.product_id,
                _products.c.title.label("product_title"),
            )
            .join(_variants, _variants.c.id == InventoryItem.variant_id)
            .join(_products, _products.c.id == _variants.c.product_id)
            .where(_variants.c.deleted_at.is_(None))
        )
        if low_stock_only:
            base = base.where(
                InventoryItem.track_inventory.is_(True),
                InventoryItem.quantity_on_hand - InventoryItem.quantity_reserved
                <= InventoryItem.reorder_point,
            )
        if query_text:
            pattern = f"%{query_text}%"
            base = base.where(_variants.c.sku.ilike(pattern) | _products.c.title.ilike(pattern))
        total = int(
            await self._session.scalar(select(func.count()).select_from(base.subquery())) or 0
        )
        page = base
        if after is not None:
            page = page.where(
                tuple_(_variants.c.sku, InventoryItem.id)
                > tuple_(literal(after[0]), literal(after[1]))
            )
        rows = (
            await self._session.execute(
                page.order_by(_variants.c.sku, InventoryItem.id).limit(limit + 1)
            )
        ).all()
        items = [
            StockRow(
                stock=_stock(row[0]),
                sku=row.sku,
                variant_title=row.title,
                product_id=row.product_id,
                product_title=row.product_title,
            )
            for row in rows[:limit]
        ]
        return items, len(rows) > limit, total

    async def variant_label(self, variant_id: uuid.UUID) -> VariantLabel | None:
        row = (
            await self._session.execute(
                select(
                    _variants.c.id,
                    _variants.c.product_id,
                    _variants.c.sku,
                    _variants.c.title,
                    _products.c.title.label("product_title"),
                    _products.c.slug,
                )
                .join(_products, _products.c.id == _variants.c.product_id)
                .where(_variants.c.id == variant_id, _variants.c.deleted_at.is_(None))
            )
        ).one_or_none()
        if row is None:
            return None
        return VariantLabel(
            variant_id=row.id,
            product_id=row.product_id,
            sku=row.sku,
            variant_title=row.title,
            product_title=row.product_title,
            product_slug=row.slug,
        )

    async def variant_labels(
        self, variant_ids: Sequence[uuid.UUID]
    ) -> dict[uuid.UUID, VariantLabel]:
        """:meth:`variant_label` for several variants, in one query."""
        if not variant_ids:
            return {}
        rows = (
            await self._session.execute(
                select(
                    _variants.c.id,
                    _variants.c.product_id,
                    _variants.c.sku,
                    _variants.c.title,
                    _products.c.title.label("product_title"),
                    _products.c.slug,
                )
                .join(_products, _products.c.id == _variants.c.product_id)
                .where(_variants.c.id.in_(variant_ids), _variants.c.deleted_at.is_(None))
            )
        ).all()
        return {
            row.id: VariantLabel(
                variant_id=row.id,
                product_id=row.product_id,
                sku=row.sku,
                variant_title=row.title,
                product_title=row.product_title,
                product_slug=row.slug,
            )
            for row in rows
        }

    async def item_id_for(self, variant_id: uuid.UUID) -> uuid.UUID | None:
        item_id: uuid.UUID | None = await self._session.scalar(
            select(InventoryItem.id).where(InventoryItem.variant_id == variant_id)
        )
        return item_id

    # ── Reservations ──────────────────────────────────────────────────────

    async def add_reservations(
        self,
        session_id: uuid.UUID,
        quantities: Sequence[tuple[uuid.UUID, int]],
        expires_at: datetime,
    ) -> None:
        """One checkout's holds ``(variant_id, quantity)``, in one INSERT."""
        if quantities:
            await self._session.execute(
                insert(InventoryReservation).values(
                    [
                        {
                            "variant_id": variant_id,
                            "checkout_session_id": session_id,
                            "quantity": quantity,
                            "expires_at": expires_at,
                        }
                        for variant_id, quantity in quantities
                    ]
                )
            )

    async def active_reservations(self, session_id: uuid.UUID) -> list[ReservationRecord]:
        """A checkout's live reservations, locked; the caller locks stock rows first."""
        rows = (
            await self._session.scalars(
                select(InventoryReservation)
                .where(
                    InventoryReservation.checkout_session_id == session_id,
                    InventoryReservation.status == "active",
                )
                .order_by(InventoryReservation.variant_id)
                .with_for_update()
            )
        ).all()
        return [
            ReservationRecord(
                id=row.id,
                variant_id=row.variant_id,
                checkout_session_id=row.checkout_session_id,
                quantity=row.quantity,
                status=row.status,
                expires_at=row.expires_at,
            )
            for row in rows
        ]

    async def reserved_variants(self, session_id: uuid.UUID) -> list[uuid.UUID]:
        """The variants a checkout holds, unlocked: to lock their stock rows in order."""
        rows = await self._session.scalars(
            select(InventoryReservation.variant_id)
            .where(
                InventoryReservation.checkout_session_id == session_id,
                InventoryReservation.status == "active",
            )
            .distinct()
        )
        return sorted(rows.all())

    async def set_reservation_status(
        self, reservation_ids: Sequence[uuid.UUID], status: str
    ) -> None:
        if reservation_ids:
            await self._session.execute(
                update(InventoryReservation)
                .where(InventoryReservation.id.in_(reservation_ids))
                .values(status=status)
            )

    async def extend_reservations(self, session_id: uuid.UUID, expires_at: datetime) -> None:
        await self._session.execute(
            update(InventoryReservation)
            .where(
                InventoryReservation.checkout_session_id == session_id,
                InventoryReservation.status == "active",
            )
            .values(expires_at=expires_at)
        )

    async def add_reserved_many(self, deltas: Mapping[uuid.UUID, int]) -> None:
        """``quantity_reserved += delta`` per variant, in one UPDATE. Lock the rows first, in
        order; the CHECK constraints are the backstop."""
        if not deltas:
            return
        rows = _rows("deltas", {"variant_id": Uuid(), "delta": Integer()}, list(deltas.items()))
        await self._session.execute(
            update(InventoryItem)
            .where(InventoryItem.variant_id == rows.c.variant_id)
            .values(
                quantity_reserved=InventoryItem.quantity_reserved + rows.c.delta,
                updated_at=func.now(),
            )
            .execution_options(synchronize_session="fetch")
        )

    # ── Back in stock ─────────────────────────────────────────────────────

    async def subscribe(self, variant_id: uuid.UUID, email: str, user_id: uuid.UUID | None) -> None:
        """Idempotent: a second request for the same variant and address is a no-op."""
        await self._session.execute(
            insert(BackInStockSubscription)
            .values(variant_id=variant_id, email=email, user_id=user_id)
            .on_conflict_do_nothing(
                index_elements=["variant_id", "email"],
                index_where=BackInStockSubscription.notified_at.is_(None),
            )
        )

    async def pending_subscriptions(
        self, variant_id: uuid.UUID, limit: int = 500
    ) -> list[SubscriptionRecord]:
        rows = (
            await self._session.scalars(
                select(BackInStockSubscription)
                .where(
                    BackInStockSubscription.variant_id == variant_id,
                    BackInStockSubscription.notified_at.is_(None),
                )
                .order_by(BackInStockSubscription.created_at)
                .limit(limit)
                .with_for_update(skip_locked=True)
            )
        ).all()
        return [
            SubscriptionRecord(
                id=row.id, variant_id=row.variant_id, email=row.email, user_id=row.user_id
            )
            for row in rows
        ]

    async def mark_notified(self, subscription_ids: Sequence[uuid.UUID]) -> None:
        if subscription_ids:
            await self._session.execute(
                update(BackInStockSubscription)
                .where(BackInStockSubscription.id.in_(subscription_ids))
                .values(notified_at=func.now())
            )

    async def pending_subscription_count(self, variant_id: uuid.UUID) -> int:
        count = await self._session.scalar(
            select(func.count())
            .select_from(BackInStockSubscription)
            .where(
                BackInStockSubscription.variant_id == variant_id,
                BackInStockSubscription.notified_at.is_(None),
            )
        )
        return int(count or 0)

    async def variant_exists(self, variant_id: uuid.UUID) -> bool:
        found = await self._session.scalar(
            select(literal(1))
            .select_from(_variants)
            .where(_variants.c.id == variant_id, _variants.c.deleted_at.is_(None))
            .limit(1)
        )
        return found is not None
