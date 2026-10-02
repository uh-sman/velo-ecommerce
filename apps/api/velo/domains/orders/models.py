"""Order, fulfilment, and return tables — DATA-MODEL.md §7.

An order is a record of an agreement at a point in time. Line items snapshot
title, SKU, price, and tax rate, and addresses are JSONB snapshots rather than
foreign keys, so no later catalog or address-book edit can rewrite history.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import CHAR, CheckConstraint, ForeignKey, Index, Numeric, func, text
from sqlalchemy.dialects.postgresql import CITEXT, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from velo.db.base import (
    Base,
    HasCreatedAt,
    HasId,
    HasTimestamps,
    JsonObject,
    json_object,
    non_negative,
    one_of,
)
from velo.db.types import MinorUnits

ORDER_STATUSES = (
    "pending",
    "paid",
    "processing",
    "partially_fulfilled",
    "fulfilled",
    "delivered",
    "cancelled",
    "refunded",
    "partially_refunded",
)
PAYMENT_STATUSES = ("pending", "authorised", "paid", "partially_refunded", "refunded", "failed")
FULFILMENT_STATUSES = ("unfulfilled", "partially_fulfilled", "fulfilled", "returned")
ACTOR_TYPES = ("customer", "staff", "system", "webhook")
SHIPMENT_STATUSES = ("pending", "in_transit", "delivered", "failed", "cancelled")
RETURN_STATUSES = (
    "requested",
    "approved",
    "rejected",
    "in_transit",
    "received",
    "refunded",
    "closed",
)
RETURN_CONDITIONS = ("new", "opened", "damaged")


class Order(HasId, HasTimestamps, Base):
    __tablename__ = "orders"

    order_number: Mapped[str] = mapped_column(unique=True)  # 'VLO-7K3M9Q' — not enumerable
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    email: Mapped[str] = mapped_column(CITEXT)
    # Unique: one order per checkout session, however many webhooks arrive.
    checkout_session_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("checkout_sessions.id"), unique=True
    )

    status: Mapped[str] = mapped_column(server_default="pending")
    payment_status: Mapped[str] = mapped_column(server_default="pending")
    fulfilment_status: Mapped[str] = mapped_column(server_default="unfulfilled")

    currency: Mapped[str] = mapped_column(CHAR(3))
    subtotal_amount: Mapped[int] = mapped_column(MinorUnits)
    discount_amount: Mapped[int] = mapped_column(MinorUnits, server_default=text("0"))
    shipping_amount: Mapped[int] = mapped_column(MinorUnits, server_default=text("0"))
    tax_amount: Mapped[int] = mapped_column(MinorUnits, server_default=text("0"))
    total_amount: Mapped[int] = mapped_column(MinorUnits)
    refunded_amount: Mapped[int] = mapped_column(MinorUnits, server_default=text("0"))

    # Snapshots, not foreign keys.
    shipping_address: Mapped[JsonObject] = mapped_column(JSONB)
    billing_address: Mapped[JsonObject] = mapped_column(JSONB)

    discount_code: Mapped[str | None]
    customer_note: Mapped[str | None]
    internal_note: Mapped[str | None]
    metadata_: Mapped[JsonObject] = json_object("metadata")
    placed_at: Mapped[datetime] = mapped_column(server_default=func.now())
    cancelled_at: Mapped[datetime | None]

    __table_args__ = (
        one_of("status", *ORDER_STATUSES),
        one_of("payment_status", *PAYMENT_STATUSES),
        one_of("fulfilment_status", *FULFILMENT_STATUSES),
        *non_negative(
            "subtotal_amount",
            "discount_amount",
            "shipping_amount",
            "tax_amount",
            "total_amount",
            "refunded_amount",
        ),
        CheckConstraint(
            "total_amount = subtotal_amount - discount_amount + shipping_amount + tax_amount",
            name="order_totals_balance",
        ),
        CheckConstraint("refunded_amount <= total_amount", name="refund_within_total"),
        Index("idx_orders_user", "user_id", text("placed_at DESC")),
        Index("idx_orders_email", "email", text("placed_at DESC")),
        Index("idx_orders_status", "status", text("placed_at DESC")),
        # The fulfilment queue: a few hundred rows out of millions.
        Index(
            "idx_orders_unfulfilled",
            "placed_at",
            postgresql_where=text("fulfilment_status = 'unfulfilled' AND status = 'paid'"),
        ),
    )


class OrderItem(HasId, HasCreatedAt, Base):
    __tablename__ = "order_items"

    order_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("orders.id", ondelete="CASCADE"))
    # A reporting convenience only. The snapshot below is the record.
    variant_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("product_variants.id", ondelete="SET NULL")
    )

    product_title: Mapped[str]
    variant_title: Mapped[str]
    sku: Mapped[str]
    image_url: Mapped[str | None]
    unit_price_amount: Mapped[int] = mapped_column(MinorUnits)
    quantity: Mapped[int]
    discount_amount: Mapped[int] = mapped_column(MinorUnits, server_default=text("0"))
    tax_rate: Mapped[Decimal] = mapped_column(Numeric(6, 4), server_default=text("0"))
    tax_amount: Mapped[int] = mapped_column(MinorUnits, server_default=text("0"))
    total_amount: Mapped[int] = mapped_column(MinorUnits)
    quantity_fulfilled: Mapped[int] = mapped_column(server_default=text("0"))
    quantity_returned: Mapped[int] = mapped_column(server_default=text("0"))

    __table_args__ = (
        *non_negative(
            "unit_price_amount",
            "discount_amount",
            "tax_amount",
            "total_amount",
            "quantity_fulfilled",
            "quantity_returned",
        ),
        CheckConstraint("quantity > 0", name="quantity_positive"),
        CheckConstraint("quantity_fulfilled <= quantity", name="fulfilled_within_ordered"),
        CheckConstraint(
            "quantity_returned <= quantity_fulfilled", name="returned_within_fulfilled"
        ),
        Index("idx_order_items_order", "order_id"),
        Index("idx_order_items_sku", "sku"),  # order search by SKU
    )


class OrderEvent(HasId, HasCreatedAt, Base):
    """Immutable audit trail of an order. INSERT only."""

    __tablename__ = "order_events"

    order_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("orders.id", ondelete="CASCADE"))
    event_type: Mapped[str]  # 'created', 'paid', 'fulfilled', 'refunded', …
    from_status: Mapped[str | None]
    to_status: Mapped[str | None]
    actor_type: Mapped[str]
    actor_id: Mapped[uuid.UUID | None]
    payload: Mapped[JsonObject] = json_object()

    __table_args__ = (
        one_of("actor_type", *ACTOR_TYPES),
        Index("idx_order_events", "order_id", "created_at"),
    )


class Fulfilment(HasId, HasCreatedAt, Base):
    __tablename__ = "fulfilments"

    order_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("orders.id", ondelete="CASCADE"))
    status: Mapped[str] = mapped_column(server_default="pending")
    carrier: Mapped[str | None]
    tracking_number: Mapped[str | None]
    tracking_url: Mapped[str | None]
    shipped_at: Mapped[datetime | None]
    delivered_at: Mapped[datetime | None]

    __table_args__ = (
        one_of("status", *SHIPMENT_STATUSES),
        Index("idx_fulfilments_order", "order_id"),
        # Carrier tracking webhooks find the shipment by its number.
        Index("idx_fulfilments_tracking", "tracking_number"),
    )


class FulfilmentItem(Base):
    __tablename__ = "fulfilment_items"

    fulfilment_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("fulfilments.id", ondelete="CASCADE"), primary_key=True
    )
    order_item_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("order_items.id", ondelete="CASCADE"), primary_key=True
    )
    quantity: Mapped[int]

    __table_args__ = (CheckConstraint("quantity > 0", name="quantity_positive"),)


class Return(HasId, HasTimestamps, Base):
    __tablename__ = "returns"

    order_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("orders.id", ondelete="CASCADE"))
    rma_number: Mapped[str] = mapped_column(unique=True)
    status: Mapped[str] = mapped_column(server_default="requested")
    reason: Mapped[str]
    customer_note: Mapped[str | None]
    staff_note: Mapped[str | None]
    refund_amount: Mapped[int | None] = mapped_column(MinorUnits)

    __table_args__ = (
        one_of("status", *RETURN_STATUSES),
        CheckConstraint("refund_amount >= 0", name="refund_amount_non_negative"),
        Index("idx_returns_order", "order_id"),
        Index("idx_returns_status", "status", "created_at"),
    )


class ReturnItem(Base):
    __tablename__ = "return_items"

    return_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("returns.id", ondelete="CASCADE"), primary_key=True
    )
    order_item_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("order_items.id"), primary_key=True)
    quantity: Mapped[int]
    restock: Mapped[bool] = mapped_column(server_default=text("true"))
    condition: Mapped[str | None]

    __table_args__ = (
        CheckConstraint("quantity > 0", name="quantity_positive"),
        one_of("condition", *RETURN_CONDITIONS),
    )
