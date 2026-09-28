"""Discount tables — DATA-MODEL.md §9."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    CHAR,
    CheckConstraint,
    ForeignKey,
    Index,
    Numeric,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, CITEXT
from sqlalchemy.orm import Mapped, mapped_column

from velo.db.base import Base, HasCreatedAt, HasId, one_of
from velo.db.types import MinorUnits

DISCOUNT_TYPES = ("percentage", "fixed_amount", "free_shipping", "buy_x_get_y")
DISCOUNT_TARGETS = ("all", "products", "collections")


class Discount(HasId, HasCreatedAt, Base):
    __tablename__ = "discounts"

    code: Mapped[str | None] = mapped_column(CITEXT, unique=True)  # NULL = automatic
    title: Mapped[str]
    type: Mapped[str]
    # 15.0000 is 15% for a percentage, or 15 minor units for a fixed amount.
    value: Mapped[Decimal] = mapped_column(Numeric(10, 4))
    currency: Mapped[str | None] = mapped_column(CHAR(3))  # required for fixed_amount
    min_subtotal_amount: Mapped[int | None] = mapped_column(MinorUnits)
    applies_to: Mapped[str] = mapped_column(server_default="all")
    target_ids: Mapped[list[uuid.UUID] | None] = mapped_column(ARRAY(Uuid))
    first_order_only: Mapped[bool] = mapped_column(server_default=text("false"))
    max_redemptions: Mapped[int | None]
    max_per_customer: Mapped[int | None]
    times_redeemed: Mapped[int] = mapped_column(server_default=text("0"))
    is_stackable: Mapped[bool] = mapped_column(server_default=text("false"))
    starts_at: Mapped[datetime] = mapped_column(server_default=func.now())
    ends_at: Mapped[datetime | None]
    is_active: Mapped[bool] = mapped_column(server_default=text("true"))

    __table_args__ = (
        one_of("type", *DISCOUNT_TYPES),
        one_of("applies_to", *DISCOUNT_TARGETS),
        CheckConstraint(
            "max_redemptions IS NULL OR times_redeemed <= max_redemptions", name="within_limit"
        ),
        CheckConstraint("ends_at IS NULL OR ends_at > starts_at", name="valid_window"),
        # Code lookup at checkout. The date window is checked by the query, not
        # the index predicate: Postgres refuses now() in an index predicate,
        # because a predicate must not change meaning over time.
        Index("idx_discounts_active", "code", postgresql_where=text("is_active")),
    )


class DiscountRedemption(HasId, HasCreatedAt, Base):
    __tablename__ = "discount_redemptions"

    discount_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("discounts.id", ondelete="CASCADE"))
    order_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("orders.id", ondelete="CASCADE"))
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    amount: Mapped[int] = mapped_column(MinorUnits)

    __table_args__ = (
        CheckConstraint("amount >= 0", name="amount_non_negative"),
        UniqueConstraint("discount_id", "order_id"),
        Index("idx_redemptions_user", "discount_id", "user_id"),
    )
