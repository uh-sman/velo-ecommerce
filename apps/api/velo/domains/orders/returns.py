"""Returns (RMA): request → approval → return label → receipt → refund.

- A customer asks to return shipped units, within the return window, with a
  reason. What a line can still return is what shipped, less what came back,
  less what other open returns already claim.
- Staff approve (the customer gets a return label with the RMA number) or
  reject, with a note.
- On receipt staff record each line's condition and **decide** whether it
  goes back into sellable stock — returned goods are frequently damaged, so
  restocking is never automatic (PAYMENTS-AND-CHECKOUT.md §8). Restocked
  units get a ``return`` movement referencing the return; written-off units
  get none: they never re-enter stock on hand.
- The refund is issued through orders/refunds.py against the returned lines,
  linked to the return, and bounded by the capture ledger like any other.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from velo.core.errors import FieldError, NotFoundError, ValidationError
from velo.domains.inventory.service import InventoryService
from velo.domains.orders.exceptions import QuantityExceededError, ReturnNotAllowedError
from velo.domains.orders.refunds import RefundLine, RefundRequest, RefundService
from velo.domains.orders.repository import OrderRecord, OrderRepository, ReturnRecord
from velo.domains.orders.rules import new_rma_number
from velo.domains.orders.state import (
    OPEN_RETURNS,
    ReturnStatus,
    fulfilment_status,
    return_transition,
)
from velo.domains.payments.registry import PaymentProviders
from velo.domains.platform.events import Actor, record_audit, record_event

RETURN_REASONS = (
    "changed_mind",
    "wrong_size",
    "not_as_described",
    "damaged",
    "defective",
    "wrong_item",
    "other",
)
CONDITIONS = ("new", "opened", "damaged")


@dataclass(frozen=True, slots=True)
class ReturnLine:
    order_item_id: uuid.UUID
    quantity: int


@dataclass(frozen=True, slots=True)
class ReceivedLine:
    order_item_id: uuid.UUID
    condition: str
    restock: bool


class ReturnService:
    def __init__(
        self,
        session: AsyncSession,
        providers: PaymentProviders,
        *,
        window_days: int = 30,
        inventory: InventoryService | None = None,
    ) -> None:
        self._session = session
        self._orders = OrderRepository(session)
        self._inventory = inventory or InventoryService(session)
        self._refunds = RefundService(session, providers, self._inventory)
        self._window = timedelta(days=window_days)

    # ── The customer's side ───────────────────────────────────────────────

    async def returnable(self, order: OrderRecord) -> dict[uuid.UUID, int]:
        """Units per line that a new return may still claim."""
        claimed: dict[uuid.UUID, int] = {}
        for existing in await self._orders.returns_for(order.id):
            if existing.status in OPEN_RETURNS and existing.status != ReturnStatus.RECEIVED:
                for item in existing.items:
                    claimed[item.order_item_id] = claimed.get(item.order_item_id, 0) + item.quantity
        return {
            item.id: max(
                0, item.quantity_fulfilled - item.quantity_returned - claimed.get(item.id, 0)
            )
            for item in await self._orders.items(order.id)
        }

    async def window_open(self, order: OrderRecord) -> bool:
        """Open until ``window_days`` after the last parcel arrived (or shipped)."""
        parcels = [p for p in await self._orders.fulfilments(order.id) if p.status != "cancelled"]
        if not parcels:
            return False
        last = max((p.delivered_at or p.shipped_at or p.created_at) for p in parcels)
        return datetime.now(UTC) <= last + self._window

    async def request(
        self,
        order_id: uuid.UUID,
        lines: list[ReturnLine],
        reason: str,
        note: str | None,
        *,
        customer_id: uuid.UUID | None,
    ) -> ReturnRecord:
        order = await self._orders.get(order_id, lock=True)
        if order is None:
            raise NotFoundError("No such order.")
        if order.status == "cancelled" or order.fulfilment_status == "unfulfilled":
            raise ReturnNotAllowedError("Nothing on this order has shipped yet.")
        if not await self.window_open(order):
            raise ReturnNotAllowedError(
                f"The {self._window.days}-day return window for this order has closed."
            )
        if reason not in RETURN_REASONS:
            raise ValidationError(
                "Choose a reason for the return.",
                errors=[FieldError(field="reason", code="invalid", message="Choose a reason.")],
            )
        if not lines:
            raise ValidationError("Choose at least one item to return.")
        left = await self.returnable(order)
        chosen: list[tuple[uuid.UUID, int]] = []
        seen: set[uuid.UUID] = set()
        for line in lines:
            available = left.get(line.order_item_id)
            if (
                available is None
                or line.order_item_id in seen
                or not 1 <= line.quantity <= available
            ):
                raise QuantityExceededError(
                    "More than can be returned from that line.",
                    errors=[
                        FieldError(
                            field=f"items.{line.order_item_id}",
                            code="too_many",
                            message=f"{available or 0} of this item can be returned.",
                        )
                    ],
                )
            seen.add(line.order_item_id)
            chosen.append((line.order_item_id, line.quantity))

        rma = new_rma_number()
        while await self._orders.rma_taken(rma):
            rma = new_rma_number()
        created = await self._orders.create_return(
            order.id,
            chosen,
            rma_number=rma,
            status=ReturnStatus.REQUESTED.value,
            reason=reason,
            customer_note=note,
        )
        await self._orders.add_event(
            order.id,
            event_type="return_requested",
            from_status=None,
            to_status=ReturnStatus.REQUESTED.value,
            actor_type="customer",
            actor_id=customer_id,
            payload={"return_id": str(created.id), "rma_number": rma, "reason": reason},
        )
        record_event(
            self._session,
            "return",
            created.id,
            "return.requested",
            {"order_number": order.order_number, "email": order.email, "rma_number": rma},
        )
        await self._session.commit()
        return created

    # ── The warehouse's side ──────────────────────────────────────────────

    async def decide(
        self, return_id: uuid.UUID, approve: bool, note: str | None, actor: Actor
    ) -> ReturnRecord:
        target = ReturnStatus.APPROVED if approve else ReturnStatus.REJECTED
        return await self._move(return_id, target, actor, staff_note=note, announce=True)

    async def mark_in_transit(self, return_id: uuid.UUID, actor: Actor) -> ReturnRecord:
        return await self._move(return_id, ReturnStatus.IN_TRANSIT, actor)

    async def close(self, return_id: uuid.UUID, actor: Actor) -> ReturnRecord:
        return await self._move(return_id, ReturnStatus.CLOSED, actor)

    async def receive(
        self,
        return_id: uuid.UUID,
        received: list[ReceivedLine],
        actor: Actor,
        note: str | None = None,
    ) -> ReturnRecord:
        """Record arrival, condition and the restock decision per line. Commits."""
        current = await self._orders.get_return(return_id, lock=True)
        if current is None:
            raise NotFoundError("No such return.")
        return_transition(current.status, ReturnStatus.RECEIVED)
        decisions = {line.order_item_id: line for line in received}
        claimed = {item.order_item_id for item in current.items}
        unknown = set(decisions) - claimed
        missing = claimed - set(decisions)
        if unknown or missing:
            raise ValidationError(
                "Record a condition and restock decision for every line of the return, and "
                "only those.",
            )
        for decision in received:
            if decision.condition not in CONDITIONS:
                raise ValidationError(f"Condition must be one of: {', '.join(CONDITIONS)}.")

        order = await self._orders.get(current.order_id, lock=True)
        assert order is not None
        items = {item.id: item for item in await self._orders.items(order.id, lock=True)}
        restock: dict[uuid.UUID, int] = {}
        for line in current.items:
            decision = decisions[line.order_item_id]
            item = items[line.order_item_id]
            await self._orders.update_return_item(
                current.id,
                line.order_item_id,
                condition=decision.condition,
                restock=decision.restock,
            )
            await self._orders.update_item(
                item.id, quantity_returned=item.quantity_returned + line.quantity
            )
            if decision.restock and item.variant_id is not None:
                restock[item.variant_id] = restock.get(item.variant_id, 0) + line.quantity
        if restock:
            await self._inventory.return_to_stock(
                restock,
                reference_type="return",
                reference_id=current.id,
                actor_id=actor.user_id,
                note=f"Return {current.rma_number}",
            )
        after = await self._orders.items(order.id)
        await self._orders.update(
            order.id,
            fulfilment_status=fulfilment_status(
                [(i.quantity, i.quantity_fulfilled, i.quantity_returned) for i in after]
            ),
        )
        return await self._move(
            current.id,
            ReturnStatus.RECEIVED,
            actor,
            staff_note=note,
            payload={
                "restocked": sum(restock.values()),
                "written_off": sum(line.quantity for line in current.items) - sum(restock.values()),
            },
        )

    async def refund(
        self,
        return_id: uuid.UUID,
        actor: Actor,
        *,
        include_shipping: bool = False,
        note: str | None = None,
    ) -> tuple[ReturnRecord, uuid.UUID]:
        """Refund the received lines. Commits; returns the refund to submit."""
        current = await self._orders.get_return(return_id, lock=True)
        if current is None:
            raise NotFoundError("No such return.")
        return_transition(current.status, ReturnStatus.REFUNDED)
        refund = await self._refunds.issue(
            current.order_id,
            RefundRequest(
                lines=[RefundLine(item.order_item_id, item.quantity) for item in current.items],
                include_shipping=include_shipping,
                reason="defective"
                if current.reason in ("damaged", "defective")
                else "requested_by_customer",
                note=note or f"Return {current.rma_number}",
            ),
            actor,
            return_id=current.id,
        )
        await self._orders.update_return(current.id, refund_amount=refund.amount)
        updated = await self._move(
            current.id,
            ReturnStatus.REFUNDED,
            actor,
            payload={"refund_id": str(refund.id), "amount": refund.amount},
        )
        return updated, refund.id

    async def submit_refund(self, refund_id: uuid.UUID) -> None:
        await self._refunds.submit(refund_id)

    # ── Internals ─────────────────────────────────────────────────────────

    async def _move(
        self,
        return_id: uuid.UUID,
        target: ReturnStatus,
        actor: Actor,
        *,
        staff_note: str | None = None,
        payload: dict[str, object] | None = None,
        announce: bool = False,
        commit: bool = True,
    ) -> ReturnRecord:
        current = await self._orders.get_return(return_id, lock=True)
        if current is None:
            raise NotFoundError("No such return.")
        if current.status != target:
            return_transition(current.status, target)
        fields: dict[str, object] = {"status": target.value}
        if staff_note is not None:
            fields["staff_note"] = staff_note
        await self._orders.update_return(current.id, **fields)
        await self._orders.add_event(
            current.order_id,
            event_type=f"return_{target.value}",
            from_status=current.status,
            to_status=target.value,
            actor_type="staff",
            actor_id=actor.user_id,
            payload={
                "return_id": str(current.id),
                "rma_number": current.rma_number,
                **(payload or {}),
            },
        )
        record_audit(
            self._session,
            actor,
            f"return.{target.value}",
            "return",
            current.id,
            {"status": {"from": current.status, "to": target.value}},
        )
        if announce:
            order = await self._orders.get(current.order_id)
            assert order is not None
            record_event(
                self._session,
                "return",
                current.id,
                f"return.{target.value}",
                {
                    "order_number": order.order_number,
                    "email": order.email,
                    "rma_number": current.rma_number,
                    "note": staff_note,
                },
            )
        if commit:
            await self._session.commit()
        updated = await self._orders.get_return(current.id)
        assert updated is not None
        return updated
