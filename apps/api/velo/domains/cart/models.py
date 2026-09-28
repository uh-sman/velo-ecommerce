"""Cart tables — DATA-MODEL.md §6.

Note what ``cart_items`` does not hold: a price. A cart records intent — this
variant, this many — and is re-priced from ``product_variants`` on every read
and every mutation.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CHAR, CheckConstraint, ForeignKey, Index, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column

from velo.db.base import Base, HasId, HasTimestamps, one_of

CART_STATUSES = ("active", "converted", "abandoned", "merged")


class Cart(HasId, HasTimestamps, Base):
    __tablename__ = "carts"

    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    # Opaque and cookie-bound; NULL once the cart is claimed by a user.
    guest_token: Mapped[str | None] = mapped_column(unique=True)
    currency: Mapped[str] = mapped_column(CHAR(3), server_default="USD")
    status: Mapped[str] = mapped_column(server_default="active")
    abandoned_at: Mapped[datetime | None]
    expires_at: Mapped[datetime] = mapped_column(server_default=text("now() + interval '30 days'"))

    __table_args__ = (
        one_of("status", *CART_STATUSES),
        CheckConstraint("user_id IS NOT NULL OR guest_token IS NOT NULL", name="cart_has_owner"),
        # One active cart per user.
        Index(
            "uq_active_user_cart",
            "user_id",
            unique=True,
            postgresql_where=text("status = 'active' AND user_id IS NOT NULL"),
        ),
        Index("idx_carts_abandoned", "abandoned_at", postgresql_where=text("status = 'abandoned'")),
    )


class CartItem(HasId, HasTimestamps, Base):
    __tablename__ = "cart_items"

    cart_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("carts.id", ondelete="CASCADE"))
    variant_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("product_variants.id", ondelete="CASCADE")
    )
    quantity: Mapped[int]

    __table_args__ = (
        CheckConstraint("quantity > 0 AND quantity <= 999", name="quantity_range"),
        # One row per variant, so "add to cart" is an upsert and a double-click
        # increments a quantity instead of adding a duplicate line.
        UniqueConstraint("cart_id", "variant_id"),
    )
