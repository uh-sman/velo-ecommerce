"""Checkout session table — DATA-MODEL.md §7."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CHAR, CheckConstraint, ForeignKey, Index, text
from sqlalchemy.dialects.postgresql import CITEXT
from sqlalchemy.orm import Mapped, mapped_column

from velo.db.base import Base, HasId, HasTimestamps, JsonObject, json_object, non_negative, one_of
from velo.db.types import MinorUnits

CHECKOUT_STATUSES = (
    "initiated",
    "address_set",
    "shipping_set",
    "payment_pending",
    "confirmed",
    "failed",
    "expired",
    "abandoned",
)


class CheckoutSession(HasId, HasTimestamps, Base):
    __tablename__ = "checkout_sessions"

    cart_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("carts.id"))
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    email: Mapped[str] = mapped_column(CITEXT)
    status: Mapped[str] = mapped_column(server_default="initiated")
    shipping_address_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("addresses.id"))
    billing_address_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("addresses.id"))
    shipping_rate_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("shipping_rates.id"))
    discount_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("discounts.id"))

    # The priced snapshot. Recomputed on every mutation, and again before capture.
    currency: Mapped[str] = mapped_column(CHAR(3), server_default="USD")
    subtotal_amount: Mapped[int] = mapped_column(MinorUnits, server_default=text("0"))
    discount_amount: Mapped[int] = mapped_column(MinorUnits, server_default=text("0"))
    shipping_amount: Mapped[int] = mapped_column(MinorUnits, server_default=text("0"))
    tax_amount: Mapped[int] = mapped_column(MinorUnits, server_default=text("0"))
    total_amount: Mapped[int] = mapped_column(MinorUnits, server_default=text("0"))
    # What the totals were computed from: priced lines, discounts, tax lines, the
    # shipping choice. Order line items are copied from it (checkout/service.py).
    snapshot: Mapped[JsonObject] = json_object()

    expires_at: Mapped[datetime] = mapped_column(
        server_default=text("now() + interval '30 minutes'")
    )

    __table_args__ = (
        one_of("status", *CHECKOUT_STATUSES),
        *non_negative(
            "subtotal_amount", "discount_amount", "shipping_amount", "tax_amount", "total_amount"
        ),
        CheckConstraint(
            "total_amount = subtotal_amount - discount_amount + shipping_amount + tax_amount",
            name="totals_balance",
        ),
        CheckConstraint("discount_amount <= subtotal_amount", name="discount_within_subtotal"),
        Index("idx_checkout_cart", "cart_id"),
        Index(
            "idx_checkout_expiry",
            "expires_at",
            postgresql_where=text("status NOT IN ('confirmed','failed','expired')"),
        ),
    )
