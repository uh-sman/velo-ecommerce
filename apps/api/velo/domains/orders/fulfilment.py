"""Fulfilment: shipping some or all of an order, and following the parcel.

A fulfilment is one parcel: the lines and units in it, a carrier, a tracking
number. An order can ship in several (partial fulfilment). What can still be
shipped from a line is what was bought, less what has shipped, less units
refunded-with-restock before shipping (orders/refunds.py) — those are no
longer part of the order.

Nothing ships while the order is unpaid, cancelled, fully refunded, or under
an open chargeback (``metadata.dispute.open``, set by the dispute webhook):
goods sent against a disputed payment are usually lost with the money.

Shipment status comes from staff or from the carrier's tracking webhook
(api/v1/webhooks.py). When every parcel of a fully shipped order is
delivered, the order is delivered.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import quote

from sqlalchemy.ext.asyncio import AsyncSession

from velo.core.errors import FieldError, NotFoundError
from velo.domains.orders.exceptions import FulfilmentBlockedError, QuantityExceededError
from velo.domains.orders.repository import FulfilmentRecord, OrderRepository
from velo.domains.orders.state import OrderStatus, fulfilment_status
from velo.domains.payments.repository import PaymentRepository
from velo.domains.platform.events import Actor, record_audit, record_event

# Tracking pages by carrier; the number is URL-quoted into ``{}``.
CARRIER_TRACKING = {
    "ups": "https://www.ups.com/track?tracknum={}",
    "usps": "https://tools.usps.com/go/TrackConfirmAction?tLabels={}",
    "fedex": "https://www.fedex.com/fedextrack/?trknbr={}",
    "dhl": "https://www.dhl.com/global-en/home/tracking.html?tracking-id={}",
    "royal_mail": "https://www.royalmail.com/track-your-item#/tracking-results/{}",
    "dpd": "https://track.dpd.co.uk/parcels/{}",
    "gig": "https://giglogistics.com/track?waybill={}",
}

# Parcel status changes allowed, by staff or by the carrier.
SHIPMENT_ALLOWED = {
    "pending": frozenset({"in_transit", "cancelled"}),
    "in_transit": frozenset({"delivered", "failed"}),
    "failed": frozenset({"in_transit", "cancelled"}),
    "delivered": frozenset(),
    "cancelled": frozenset(),
}

_SHIPPABLE = frozenset(
    {
        OrderStatus.PAID,
        OrderStatus.PARTIALLY_REFUNDED,
        OrderStatus.PROCESSING,
        OrderStatus.PARTIALLY_FULFILLED,
    }
)


def tracking_url(carrier: str | None, number: str | None) -> str | None:
    if not carrier or not number:
        return None
    template = CARRIER_TRACKING.get(carrier.strip().lower().replace(" ", "_"))
    return template.format(quote(number, safe="")) if template else None


@dataclass(frozen=True, slots=True)
class ShipLine:
    order_item_id: uuid.UUID
    quantity: int


class FulfilmentService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._orders = OrderRepository(session)
        self._payments = PaymentRepository(session)

    async def fulfil(
        self,
        order_id: uuid.UUID,
        lines: list[ShipLine] | None,
        actor: Actor,
        *,
        carrier: str | None,
        tracking_number: str | None,
        tracking: str | None = None,
        notify: bool = True,
    ) -> FulfilmentRecord:
        """Ship ``lines`` (``None``: everything left). Commits."""
        order = await self._orders.get(order_id, lock=True)
        if order is None:
            raise NotFoundError("No such order.")
        if order.status not in _SHIPPABLE:
            raise FulfilmentBlockedError(f"An order that is {order.status} cannot be shipped.")
        if order.metadata.get("dispute", {}).get("open"):
            raise FulfilmentBlockedError(
                "This order's payment is disputed. Hold the goods until the dispute closes."
            )

        items = {item.id: item for item in await self._orders.items(order.id, lock=True)}
        refunded = await self._payments.refunded_units(order.id)
        shippable = {
            item.id: item.quantity - item.quantity_fulfilled - refunded.get(item.id, (0, 0))[1]
            for item in items.values()
        }
        if lines is None:
            chosen = [(item_id, left) for item_id, left in shippable.items() if left > 0]
        else:
            chosen = []
            seen: set[uuid.UUID] = set()
            for line in lines:
                left = shippable.get(line.order_item_id)
                if left is None or line.order_item_id in seen or not 1 <= line.quantity <= left:
                    raise QuantityExceededError(
                        "Each line once, and no more than is left to ship.",
                        errors=[
                            FieldError(
                                field=f"lines.{line.order_item_id}",
                                code="too_many",
                                message=f"{max(left or 0, 0)} of this line can still ship.",
                            )
                        ],
                    )
                seen.add(line.order_item_id)
                chosen.append((line.order_item_id, line.quantity))
        if not chosen:
            raise QuantityExceededError("Everything on this order has already shipped.")

        now = datetime.now(UTC)
        fulfilment = await self._orders.create_fulfilment(
            order.id,
            chosen,
            status="in_transit",
            carrier=carrier,
            tracking_number=tracking_number,
            tracking_url=tracking or tracking_url(carrier, tracking_number),
            shipped_at=now,
        )
        for item_id, quantity in chosen:
            await self._orders.update_item(
                item_id, quantity_fulfilled=items[item_id].quantity_fulfilled + quantity
            )
        after = await self._orders.items(order.id)
        shipped_state = fulfilment_status(
            [(i.quantity, i.quantity_fulfilled, i.quantity_returned) for i in after]
        )
        # Lines refunded before shipping count as done: the order is fulfilled
        # when nothing is left to ship.
        nothing_left = all(
            i.quantity - i.quantity_fulfilled - refunded.get(i.id, (0, 0))[1] <= 0 for i in after
        )
        if nothing_left:
            shipped_state = "fulfilled"
        new_status = (
            OrderStatus.FULFILLED if nothing_left else OrderStatus.PARTIALLY_FULFILLED
        ).value
        await self._orders.update(order.id, fulfilment_status=shipped_state, status=new_status)
        await self._orders.add_event(
            order.id,
            event_type="fulfilled" if nothing_left else "partially_fulfilled",
            from_status=order.status,
            to_status=new_status,
            actor_type="staff",
            actor_id=actor.user_id,
            payload={
                "fulfilment_id": str(fulfilment.id),
                "carrier": carrier,
                "tracking_number": tracking_number,
                "lines": [{"order_item_id": str(i), "quantity": q} for i, q in chosen],
            },
        )
        record_audit(
            self._session,
            actor,
            "order.fulfilled",
            "order",
            order.id,
            {"fulfilment_id": str(fulfilment.id), "units": sum(q for _, q in chosen)},
        )
        if notify:
            record_event(
                self._session,
                "order",
                order.id,
                "order.shipped",
                {
                    "order_number": order.order_number,
                    "email": order.email,
                    "carrier": carrier,
                    "tracking_number": tracking_number,
                    "tracking_url": fulfilment.tracking_url,
                    "lines": [
                        {
                            "title": items[i].product_title,
                            "variant": items[i].variant_title,
                            "quantity": q,
                        }
                        for i, q in chosen
                    ],
                    "complete": nothing_left,
                },
            )
        await self._session.commit()
        return fulfilment

    async def update_shipment(
        self,
        fulfilment_id: uuid.UUID,
        status: str,
        *,
        actor: Actor | None,
        occurred_at: datetime | None = None,
        tracking_number: str | None = None,
        carrier: str | None = None,
    ) -> FulfilmentRecord:
        """Move a parcel on. ``actor`` None: the carrier's webhook. Commits.

        A status the parcel already has is accepted and ignored — carriers
        repeat themselves.
        """
        fulfilment = await self._orders.fulfilment(fulfilment_id, lock=True)
        if fulfilment is None:
            raise NotFoundError("No such fulfilment.")
        changes: dict[str, object] = {}
        if tracking_number is not None and tracking_number != fulfilment.tracking_number:
            changes["tracking_number"] = tracking_number
        if carrier is not None and carrier != fulfilment.carrier:
            changes["carrier"] = carrier
        if changes:
            changes["tracking_url"] = tracking_url(
                str(changes.get("carrier", fulfilment.carrier) or ""),
                str(changes.get("tracking_number", fulfilment.tracking_number) or ""),
            )
        if status != fulfilment.status:
            if status not in SHIPMENT_ALLOWED.get(fulfilment.status, frozenset()):
                raise FulfilmentBlockedError(
                    f"A parcel that is {fulfilment.status} cannot become {status}."
                )
            changes["status"] = status
            if status == "delivered":
                changes["delivered_at"] = occurred_at or datetime.now(UTC)
        if not changes:
            await self._session.commit()
            return fulfilment

        order = await self._orders.get(fulfilment.order_id, lock=True)
        assert order is not None
        await self._orders.update_fulfilment(fulfilment.id, **changes)
        await self._orders.add_event(
            order.id,
            event_type=f"shipment_{changes.get('status', 'updated')}",
            from_status=fulfilment.status,
            to_status=str(changes.get("status", fulfilment.status)),
            actor_type="staff" if actor else "webhook",
            actor_id=actor.user_id if actor else None,
            payload={
                "fulfilment_id": str(fulfilment.id),
                **{k: str(v) for k, v in changes.items()},
            },
        )
        if actor is not None:
            record_audit(
                self._session,
                actor,
                "order.shipment_updated",
                "fulfilment",
                fulfilment.id,
                {k: str(v) for k, v in changes.items()},
            )

        if changes.get("status") == "delivered" and order.status == OrderStatus.FULFILLED:
            parcels = await self._orders.fulfilments(order.id)
            live = [p for p in parcels if p.status != "cancelled"]
            if live and all((p.status == "delivered" or p.id == fulfilment.id) for p in live):
                await self._orders.update(order.id, status=OrderStatus.DELIVERED.value)
                await self._orders.add_event(
                    order.id,
                    event_type="delivered",
                    from_status=order.status,
                    to_status=OrderStatus.DELIVERED.value,
                    actor_type="staff" if actor else "webhook",
                    actor_id=actor.user_id if actor else None,
                    payload={},
                )
                record_event(
                    self._session,
                    "order",
                    order.id,
                    "order.delivered",
                    {"order_number": order.order_number, "email": order.email},
                )
        elif changes.get("status") == "failed":
            record_event(
                self._session,
                "order",
                order.id,
                "order.needs_attention",
                {
                    "order_number": order.order_number,
                    "reason": "delivery_failed",
                    "tracking_number": fulfilment.tracking_number,
                },
            )
        await self._session.commit()
        updated = await self._orders.fulfilment(fulfilment.id)
        assert updated is not None
        return updated

    async def by_tracking(self, tracking_number: str) -> list[FulfilmentRecord]:
        return await self._orders.fulfilments_by_tracking(tracking_number)
