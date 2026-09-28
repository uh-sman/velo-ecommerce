"""Inventory service: stock levels, the movement ledger, alerts, back-in-stock.

Rules:

- Available-to-sell is ``on_hand - reserved``, computed, never stored.
- Every change to ``quantity_on_hand`` writes a movement with a reason and an
  actor, in the same transaction. The ledger is append-only, so the sum of a
  variant's movements always equals its stock on hand.
- An adjustment cannot take on-hand below what checkouts have reserved. The
  database refuses it too (``reserved_within_stock``); this gives the operator
  a readable error instead of a constraint violation.
- Crossing the reorder point raises one low-stock alert; going from sold out
  to available notifies back-in-stock subscribers. Both are outbox events,
  delivered by the worker after commit.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from velo.core.errors import NotFoundError
from velo.core.jobs import JobQueue, NullJobQueue
from velo.domains.inventory.exceptions import (
    AlreadyInStockError,
    InsufficientStockError,
    InvalidAdjustmentError,
)
from velo.domains.inventory.repository import (
    InventoryRepository,
    MovementRecord,
    StockRecord,
    StockRow,
    SubscriptionRecord,
    VariantLabel,
)
from velo.domains.platform.events import Actor, diff, record_audit, record_event

# Reasons an operator may give by hand. 'sale' and 'initial' are written by
# checkout and by variant creation, never typed into the admin.
MANUAL_REASONS = {
    "restock": 1,  # must add stock
    "return": 1,
    "damage": -1,  # must remove stock
    "theft": -1,
    "adjustment": 0,  # either direction: a stocktake correction
}


@dataclass(frozen=True, slots=True)
class Availability:
    in_stock: bool
    quantity_available: int | None  # None: not tracked, or above the display threshold


@dataclass(frozen=True, slots=True)
class AdjustmentResult:
    stock: StockRecord
    movement: MovementRecord


class InventoryService:
    def __init__(
        self,
        session: AsyncSession,
        *,
        jobs: JobQueue | None = None,
        display_threshold: int = 20,
    ) -> None:
        self._session = session
        self._stock = InventoryRepository(session)
        self._jobs = jobs or NullJobQueue()
        self._threshold = display_threshold

    # ── Reads ─────────────────────────────────────────────────────────────

    async def availability(self, variant_ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, Availability]:
        """What the storefront may show. Exact counts only when low (API-SPEC.md §2)."""
        stock = await self._stock.stock(variant_ids)
        result: dict[uuid.UUID, Availability] = {}
        for variant_id in variant_ids:
            record = stock.get(variant_id)
            if record is None:
                result[variant_id] = Availability(in_stock=False, quantity_available=0)
                continue
            shown: int | None = None
            if record.track_inventory and not record.allow_backorder:
                available = max(record.available, 0)
                shown = available if available <= self._threshold else None
            result[variant_id] = Availability(in_stock=record.sellable, quantity_available=shown)
        return result

    async def sellable_quantities(
        self, variant_ids: Sequence[uuid.UUID]
    ) -> dict[uuid.UUID, int | None]:
        """How many of each variant can be sold now; None means no limit.

        No limit: stock is not tracked, or backorders are allowed. A variant
        with no stock record cannot be sold (0).
        """
        stock = await self._stock.stock(variant_ids)
        result: dict[uuid.UUID, int | None] = {}
        for variant_id in variant_ids:
            record = stock.get(variant_id)
            if record is None:
                result[variant_id] = 0
            elif not record.track_inventory or record.allow_backorder:
                result[variant_id] = None
            else:
                result[variant_id] = max(record.available, 0)
        return result

    async def stock(self, variant_id: uuid.UUID) -> StockRecord:
        record = (await self._stock.stock([variant_id])).get(variant_id)
        if record is None:
            raise NotFoundError("No stock record for that variant.")
        return record

    async def list_stock(
        self,
        *,
        low_stock_only: bool = False,
        query_text: str | None = None,
        limit: int = 50,
        after: tuple[str, uuid.UUID] | None = None,
    ) -> tuple[list[StockRow], bool, int]:
        return await self._stock.list_stock(
            low_stock_only=low_stock_only, query_text=query_text, limit=limit, after=after
        )

    async def movements(
        self,
        variant_id: uuid.UUID,
        *,
        limit: int = 50,
        after: tuple[datetime, uuid.UUID] | None = None,
    ) -> tuple[list[MovementRecord], bool]:
        if not await self._stock.variant_exists(variant_id):
            raise NotFoundError("No such variant.")
        return await self._stock.movements(variant_id, limit=limit, after=after)

    # ── Writes ────────────────────────────────────────────────────────────

    async def open_stock(
        self,
        variant_id: uuid.UUID,
        *,
        quantity: int,
        reorder_point: int,
        track_inventory: bool = True,
        allow_backorder: bool = False,
        actor: Actor,
    ) -> StockRecord:
        """The stock record of a new variant, and its opening ledger entry.

        Runs inside the caller's transaction (catalog variant creation); the
        caller commits.
        """
        if quantity < 0 or reorder_point < 0:
            raise InvalidAdjustmentError("Stock and reorder point cannot be negative.")
        record = await self._stock.create(
            variant_id,
            quantity_on_hand=quantity,
            reorder_point=reorder_point,
            track_inventory=track_inventory,
            allow_backorder=allow_backorder,
        )
        if quantity:
            await self._stock.add_movement(
                variant_id=variant_id,
                quantity_delta=quantity,
                reason="initial",
                reference_type="manual",
                actor_id=actor.user_id,
                note="Opening stock",
            )
        return record

    async def adjust(
        self,
        variant_id: uuid.UUID,
        *,
        delta: int,
        reason: str,
        note: str | None,
        actor: Actor,
    ) -> AdjustmentResult:
        direction = MANUAL_REASONS.get(reason)
        if direction is None:
            allowed = ", ".join(sorted(MANUAL_REASONS))
            raise InvalidAdjustmentError(f"Reason must be one of: {allowed}.")
        if delta == 0:
            raise InvalidAdjustmentError("An adjustment must change the quantity.")
        if direction > 0 and delta < 0:
            raise InvalidAdjustmentError(f"A {reason} adds stock; the quantity must be positive.")
        if direction < 0 and delta > 0:
            raise InvalidAdjustmentError(
                f"A {reason} removes stock; the quantity must be negative."
            )

        label = await self._require_variant(variant_id)
        before = await self._stock.lock(variant_id)
        if before is None:
            raise NotFoundError("No stock record for that variant.")
        on_hand = before.quantity_on_hand + delta
        if on_hand < 0:
            raise InsufficientStockError(
                f"Only {before.quantity_on_hand} on hand; cannot remove {-delta}."
            )
        if on_hand < before.quantity_reserved:
            raise InsufficientStockError(
                f"{before.quantity_reserved} are reserved by checkouts in progress; "
                f"on hand cannot go below that."
            )

        after = await self._stock.update(variant_id, quantity_on_hand=on_hand)
        movement = await self._stock.add_movement(
            variant_id=variant_id,
            quantity_delta=delta,
            reason=reason,
            reference_type="manual",
            actor_id=actor.user_id,
            note=note,
        )
        record_audit(
            self._session,
            actor,
            "inventory.adjusted",
            "inventory_item",
            await self._stock.item_id_for(variant_id),
            {
                "quantity_on_hand": {"from": before.quantity_on_hand, "to": on_hand},
                "reason": reason,
                "sku": label.sku,
            },
        )
        self._announce(label, before, after)
        await self._session.commit()
        await self._jobs.kick_outbox()
        return AdjustmentResult(stock=after, movement=movement)

    async def update_settings(
        self,
        variant_id: uuid.UUID,
        *,
        reorder_point: int | None = None,
        track_inventory: bool | None = None,
        allow_backorder: bool | None = None,
        actor: Actor,
    ) -> StockRecord:
        label = await self._require_variant(variant_id)
        before = await self._stock.lock(variant_id)
        if before is None:
            raise NotFoundError("No stock record for that variant.")
        changes = {
            key: value
            for key, value in {
                "reorder_point": reorder_point,
                "track_inventory": track_inventory,
                "allow_backorder": allow_backorder,
            }.items()
            if value is not None
        }
        if reorder_point is not None and reorder_point < 0:
            raise InvalidAdjustmentError("The reorder point cannot be negative.")
        if not changes:
            return before
        after = await self._stock.update(variant_id, **changes)
        record_audit(
            self._session,
            actor,
            "inventory.settings_updated",
            "inventory_item",
            await self._stock.item_id_for(variant_id),
            diff(
                {key: getattr(before, key) for key in changes},
                {key: getattr(after, key) for key in changes},
            ),
        )
        self._announce(label, before, after)
        await self._session.commit()
        await self._jobs.kick_outbox()
        return after

    def _announce(self, label: VariantLabel, before: StockRecord, after: StockRecord) -> None:
        """Outbox events for whatever this change means to the rest of the system."""
        payload = {
            "product_id": str(label.product_id),
            "sku": label.sku,
            "available": after.available,
        }
        record_event(self._session, "inventory", label.variant_id, "inventory.changed", payload)
        was_low = before.track_inventory and before.available <= before.reorder_point
        is_low = after.track_inventory and after.available <= after.reorder_point
        if is_low and not was_low:
            record_event(
                self._session,
                "inventory",
                label.variant_id,
                "inventory.low_stock",
                {
                    **payload,
                    "reorder_point": after.reorder_point,
                    "product_title": label.product_title,
                    "variant_title": label.variant_title,
                },
            )
        if after.sellable and not before.sellable:
            record_event(
                self._session, "inventory", label.variant_id, "inventory.restocked", payload
            )

    async def _require_variant(self, variant_id: uuid.UUID) -> VariantLabel:
        label = await self._stock.variant_label(variant_id)
        if label is None:
            raise NotFoundError("No such variant.")
        return label

    # ── Back in stock ─────────────────────────────────────────────────────

    async def subscribe(self, variant_id: uuid.UUID, email: str, user_id: uuid.UUID | None) -> None:
        await self._require_variant(variant_id)
        record = (await self._stock.stock([variant_id])).get(variant_id)
        if record is not None and record.sellable:
            raise AlreadyInStockError("This is in stock now — add it to your bag.")
        await self._stock.subscribe(variant_id, email.strip().lower(), user_id)
        await self._session.commit()

    async def claim_subscribers(
        self, variant_id: uuid.UUID
    ) -> tuple[VariantLabel | None, list[SubscriptionRecord]]:
        """For the worker: the pending subscribers of a variant that is sellable again.

        Returns no subscribers if it sold out again before the job ran — an email
        saying "back in stock" about something that is not would be worse than none.
        """
        label = await self._stock.variant_label(variant_id)
        record = (await self._stock.stock([variant_id])).get(variant_id)
        if label is None or record is None or not record.sellable:
            return label, []
        return label, await self._stock.pending_subscriptions(variant_id)

    async def mark_notified(self, subscription_ids: Sequence[uuid.UUID]) -> None:
        await self._stock.mark_notified(subscription_ids)

    async def ledger_matches(self, variant_id: uuid.UUID) -> bool:
        """The invariant: movements sum to stock on hand."""
        return (await self._stock.ledger_total(variant_id)) == (
            await self.stock(variant_id)
        ).quantity_on_hand
