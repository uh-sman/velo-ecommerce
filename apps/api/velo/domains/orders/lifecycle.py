"""An order after it is placed: cancellation, hand-set statuses, internal notes.

Every change writes an ``order_events`` row — who, when, from what, to what,
and why — in the same transaction. ``order_events`` is insert-only: the audit
trail cannot be edited after the fact (DATA-MODEL.md §7).

**Cancellation** is allowed until anything ships. It puts back exactly the
stock the order took (read from the inventory ledger, which may be less than
it bought — inventory/service.py, ``commit_sale``) and refunds everything not
yet refunded. The refund is recorded here; the caller submits it to the
provider after commit (orders/refunds.py).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from velo.core.errors import NotFoundError
from velo.domains.inventory.service import InventoryService
from velo.domains.orders.exceptions import NotCancellableError
from velo.domains.orders.refunds import RefundLine, RefundRequest, RefundService
from velo.domains.orders.repository import OrderRecord, OrderRepository
from velo.domains.orders.state import (
    MANUAL_TARGETS,
    IllegalOrderTransitionError,
    OrderStatus,
    transition,
)
from velo.domains.payments.registry import PaymentProviders
from velo.domains.payments.repository import PaymentRepository
from velo.domains.platform.events import Actor, record_audit, record_event

# A customer may cancel until staff start work on the order; staff until it ships.
CUSTOMER_CANCELLABLE = frozenset({OrderStatus.PAID, OrderStatus.PARTIALLY_REFUNDED})
STAFF_CANCELLABLE = CUSTOMER_CANCELLABLE | {OrderStatus.PROCESSING, OrderStatus.PENDING}


def cancellable(order: OrderRecord, *, by_customer: bool) -> bool:
    allowed = CUSTOMER_CANCELLABLE if by_customer else STAFF_CANCELLABLE
    return order.status in allowed and order.fulfilment_status == "unfulfilled"


class OrderLifecycle:
    def __init__(
        self,
        session: AsyncSession,
        providers: PaymentProviders,
        inventory: InventoryService | None = None,
    ) -> None:
        self._session = session
        self._orders = OrderRepository(session)
        self._payments = PaymentRepository(session)
        self._inventory = inventory or InventoryService(session)
        self._refunds = RefundService(session, providers, self._inventory)

    async def cancel(
        self,
        order_id: uuid.UUID,
        actor: Actor,
        *,
        by_customer: bool,
        reason: str | None = None,
    ) -> tuple[OrderRecord, uuid.UUID | None]:
        """Cancel, restock and record the refund. Commits; returns the refund to submit."""
        order = await self._orders.get(order_id, lock=True)
        if order is None:
            raise NotFoundError("No such order.")
        if not cancellable(order, by_customer=by_customer) or await self._orders.fulfilments(
            order.id
        ):
            raise NotCancellableError(
                "This order has started shipping, so it can no longer be cancelled. "
                "You can return it once it arrives."
                if order.fulfilment_status != "unfulfilled"
                else f"An order that is {order.status} cannot be cancelled."
            )
        if order.metadata.get("dispute", {}).get("open"):
            raise NotCancellableError("This order is under a chargeback; the bank decides it.")

        target = transition(order.status, OrderStatus.CANCELLED)
        actor_type = "customer" if by_customer else "staff"

        taken = await self._inventory.taken_for_order(order.id)
        if taken:
            await self._inventory.return_to_stock(
                taken,
                reference_type="order",
                reference_id=order.id,
                actor_id=actor.user_id,
                note="Order cancelled",
            )

        refund_id: uuid.UUID | None = None
        payment = await self._payments.settled_payment_for_order(order.id)
        if payment is not None and payment.amount_captured > payment.amount_refunded:
            refunded = await self._payments.refunded_units(order.id)
            lines = [
                RefundLine(item.id, item.quantity - refunded.get(item.id, (0, 0))[0], restock=True)
                for item in await self._orders.items(order.id)
                if item.quantity - refunded.get(item.id, (0, 0))[0] > 0
            ]
            refund = await self._refunds.issue(
                order.id,
                RefundRequest(
                    lines=lines,
                    include_shipping=True,
                    reason="requested_by_customer" if by_customer else "other",
                    note=reason or "Order cancelled",
                ),
                actor,
                actor_type=actor_type,
                cap_to_ceiling=True,
                restock=False,  # the ledger-exact restock above has done it
            )
            refund_id = refund.id

        updated = await self._orders.update(
            order.id, status=target.value, cancelled_at=datetime.now(UTC)
        )
        await self._orders.add_event(
            order.id,
            event_type="cancelled",
            from_status=order.status,
            to_status=target.value,
            actor_type=actor_type,
            actor_id=actor.user_id,
            payload={"reason": reason} if reason else {},
        )
        if not by_customer:
            record_audit(
                self._session, actor, "order.cancelled", "order", order.id, {"reason": reason}
            )
        record_event(
            self._session,
            "order",
            order.id,
            "order.cancelled",
            {
                "order_number": order.order_number,
                "email": order.email,
                "by_customer": by_customer,
                "currency": order.currency,
            },
        )
        await self._session.commit()
        return updated, refund_id

    async def submit_refund(self, refund_id: uuid.UUID) -> None:
        await self._refunds.submit(refund_id)

    async def set_status(
        self, order_id: uuid.UUID, target: str, actor: Actor, *, reason: str | None
    ) -> OrderRecord:
        """The statuses an operator sets by hand: ``processing`` and ``delivered``."""
        order = await self._orders.get(order_id, lock=True)
        if order is None:
            raise NotFoundError("No such order.")
        if target not in MANUAL_TARGETS:
            raise IllegalOrderTransitionError(
                f"{target} follows from an action (fulfil, cancel, refund), not a status change."
            )
        new = transition(order.status, target)
        updated = await self._orders.update(order.id, status=new.value)
        await self._orders.add_event(
            order.id,
            event_type="status_changed",
            from_status=order.status,
            to_status=new.value,
            actor_type="staff",
            actor_id=actor.user_id,
            payload={"reason": reason} if reason else {},
        )
        record_audit(
            self._session,
            actor,
            "order.status_changed",
            "order",
            order.id,
            {"status": {"from": order.status, "to": new.value}, "reason": reason},
        )
        if new == OrderStatus.DELIVERED:
            record_event(
                self._session,
                "order",
                order.id,
                "order.delivered",
                {"order_number": order.order_number, "email": order.email},
            )
        await self._session.commit()
        return updated

    async def set_note(self, order_id: uuid.UUID, note: str | None, actor: Actor) -> OrderRecord:
        order = await self._orders.get(order_id, lock=True)
        if order is None:
            raise NotFoundError("No such order.")
        updated = await self._orders.update(order.id, internal_note=note)
        await self._orders.add_event(
            order.id,
            event_type="note_updated",
            from_status=None,
            to_status=None,
            actor_type="staff",
            actor_id=actor.user_id,
            payload={"note": note},
        )
        record_audit(
            self._session,
            actor,
            "order.note_updated",
            "order",
            order.id,
            {"internal_note": {"from": order.internal_note, "to": note}},
        )
        await self._session.commit()
        return updated
