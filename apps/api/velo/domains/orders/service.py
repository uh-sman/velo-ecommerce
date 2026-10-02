"""Orders: created from a paid checkout, and the record of what was agreed.

An order is placed only by settlement (checkout/settlement.py) after the
provider says the money moved — never by a browser redirect (ADR-010). It is
placed inside the settlement's transaction, alongside the stock movement, the
payment update and the discount redemptions: all of it commits, or none.

**Snapshots.** Every line copies the product and variant titles, SKU, image,
unit price, discount, tax rate and tax from the checkout's priced snapshot —
what the customer was charged for. Addresses are copied as JSON. A later edit
to the catalog or the address book never alters a historical order.

**Order numbers** are ``VLO-`` and six characters from a 30-letter alphabet
without look-alikes (no 0/O, 1/I/L, or U): about 729 million, drawn at random.
Not the UUID, which is unreadable over the phone; not a sequence, which tells
anyone with two orders how many the store takes a day.
"""

from __future__ import annotations

import secrets
import uuid
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from velo.core.logging import get_logger
from velo.domains.orders.repository import OrderItemRecord, OrderRecord, OrderRepository
from velo.domains.platform.events import record_event

logger = get_logger(__name__)

ORDER_NUMBER_PREFIX = "VLO-"
ORDER_NUMBER_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"
ORDER_NUMBER_LENGTH = 6


def new_order_number() -> str:
    return ORDER_NUMBER_PREFIX + "".join(
        secrets.choice(ORDER_NUMBER_ALPHABET) for _ in range(ORDER_NUMBER_LENGTH)
    )


@dataclass(frozen=True, slots=True)
class OrderLineDraft:
    variant_id: uuid.UUID
    product_title: str
    variant_title: str
    sku: str
    image_url: str | None
    unit_price: int
    quantity: int
    discount: int
    tax_rate: Decimal
    tax: int
    total: int


@dataclass(frozen=True, slots=True)
class OrderDraft:
    user_id: uuid.UUID | None
    email: str
    checkout_session_id: uuid.UUID
    currency: str
    subtotal: int
    discount: int
    shipping: int
    tax: int
    total: int
    shipping_address: dict[str, Any]
    billing_address: dict[str, Any]
    discount_code: str | None
    lines: list[OrderLineDraft]
    metadata: dict[str, Any] = field(default_factory=dict)


class OrderService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._orders = OrderRepository(session)

    async def place(
        self, order_id: uuid.UUID, draft: OrderDraft, *, actor_type: str = "webhook"
    ) -> OrderRecord:
        """Insert the order, its lines and its first events. The caller commits."""
        order = await self._insert(order_id, draft)
        for line in draft.lines:
            await self._orders.add_item(
                order.id,
                variant_id=line.variant_id,
                product_title=line.product_title,
                variant_title=line.variant_title,
                sku=line.sku,
                image_url=line.image_url,
                unit_price_amount=line.unit_price,
                quantity=line.quantity,
                discount_amount=line.discount,
                tax_rate=line.tax_rate,
                tax_amount=line.tax,
                total_amount=line.total,
            )
        await self._orders.add_event(
            order.id,
            event_type="created",
            from_status=None,
            to_status="paid",
            actor_type=actor_type,
            actor_id=None,
            payload={"checkout_session_id": str(draft.checkout_session_id)},
        )
        await self._orders.flush()
        record_event(
            self._session,
            "order",
            order.id,
            "order.created",
            {
                "order_number": order.order_number,
                "email": order.email,
                "total": order.total_amount,
                "currency": order.currency,
            },
        )
        return order

    async def _insert(self, order_id: uuid.UUID, draft: OrderDraft) -> OrderRecord:
        for _ in range(5):
            number = new_order_number()
            if await self._orders.number_taken(number):
                continue
            try:
                async with self._session.begin_nested():
                    return await self._orders.create(
                        order_id,
                        order_number=number,
                        user_id=draft.user_id,
                        email=draft.email,
                        checkout_session_id=draft.checkout_session_id,
                        status="paid",
                        payment_status="paid",
                        currency=draft.currency,
                        subtotal_amount=draft.subtotal,
                        discount_amount=draft.discount,
                        shipping_amount=draft.shipping,
                        tax_amount=draft.tax,
                        total_amount=draft.total,
                        shipping_address=draft.shipping_address,
                        billing_address=draft.billing_address,
                        discount_code=draft.discount_code,
                        metadata=draft.metadata,
                    )
            except IntegrityError as exc:
                if "order_number" not in str(exc.orig):
                    raise
                logger.info("order_number_collision", number=number)
        raise RuntimeError("could not draw an unused order number")  # pragma: no cover

    # ── Reads ─────────────────────────────────────────────────────────────

    async def by_checkout(self, session_id: uuid.UUID) -> OrderRecord | None:
        return await self._orders.by_checkout(session_id)

    async def get(self, order_id: uuid.UUID, *, lock: bool = False) -> OrderRecord | None:
        return await self._orders.get(order_id, lock=lock)

    async def items(self, order_id: uuid.UUID) -> list[OrderItemRecord]:
        return await self._orders.items(order_id)

    # ── What the provider reports after the sale ──────────────────────────

    async def record_refunded(
        self,
        order_id: uuid.UUID,
        refunded_total: int,
        *,
        payload: dict[str, Any],
        actor_type: str = "webhook",
        actor_id: uuid.UUID | None = None,
    ) -> OrderRecord | None:
        """Set the order's refunded amount to the ledger's cumulative figure."""
        order = await self._orders.get(order_id, lock=True)
        if order is None or refunded_total <= order.refunded_amount:
            return order  # a replay, or news we already have
        refunded = min(refunded_total, order.total_amount)
        full = refunded >= order.total_amount
        status = "refunded" if full else "partially_refunded"
        updated = await self._orders.update(
            order_id,
            refunded_amount=refunded,
            payment_status=status,
            # A refund does not undo fulfilment; it describes the money.
            **({"status": status} if order.status in ("paid", "partially_refunded") else {}),
        )
        await self._orders.add_event(
            order_id,
            event_type="refunded",
            from_status=order.payment_status,
            to_status=status,
            actor_type=actor_type,
            actor_id=actor_id,
            payload={**payload, "refunded_amount": refunded},
        )
        record_event(
            self._session,
            "order",
            order_id,
            "refund.issued",
            {
                "order_number": order.order_number,
                "email": order.email,
                "amount": refunded - order.refunded_amount,
                "refunded_total": refunded,
                "currency": order.currency,
            },
        )
        return updated

    async def record_dispute(
        self, order_id: uuid.UUID, dispute: dict[str, Any], *, opened: bool
    ) -> None:
        """Flag (or close) a chargeback. Fulfilment checks ``metadata.dispute`` (Phase 9)."""
        order = await self._orders.get(order_id, lock=True)
        if order is None:
            return
        metadata = {**order.metadata, "dispute": {**dispute, "open": opened}}
        await self._orders.update(order_id, metadata=metadata)
        await self._orders.add_event(
            order_id,
            event_type="dispute_opened" if opened else "dispute_closed",
            from_status=None,
            to_status=None,
            actor_type="webhook",
            actor_id=None,
            payload=dispute,
        )
        record_event(
            self._session,
            "order",
            order_id,
            "order.dispute_opened" if opened else "order.dispute_closed",
            {"order_number": order.order_number, **dispute},
        )
