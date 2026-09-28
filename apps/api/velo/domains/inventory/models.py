"""Inventory tables — DATA-MODEL.md §5, the oversell guard.

Available-to-sell is never stored: it is ``quantity_on_hand -
quantity_reserved``, computed when read.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, ForeignKey, Index, func, text
from sqlalchemy.orm import Mapped, mapped_column

from velo.db.base import Base, HasCreatedAt, HasId, one_of

MOVEMENT_REASONS = ("sale", "return", "restock", "adjustment", "damage", "theft", "initial")
RESERVATION_STATUSES = ("active", "committed", "released", "expired")


class InventoryItem(HasId, Base):
    __tablename__ = "inventory_items"

    variant_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("product_variants.id", ondelete="CASCADE"), unique=True
    )
    quantity_on_hand: Mapped[int] = mapped_column(server_default=text("0"))
    quantity_reserved: Mapped[int] = mapped_column(server_default=text("0"))
    reorder_point: Mapped[int] = mapped_column(server_default=text("0"))
    track_inventory: Mapped[bool] = mapped_column(server_default=text("true"))
    allow_backorder: Mapped[bool] = mapped_column(server_default=text("false"))
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        CheckConstraint("quantity_on_hand >= 0", name="quantity_on_hand_non_negative"),
        CheckConstraint("quantity_reserved >= 0", name="quantity_reserved_non_negative"),
        # The single most important constraint in the schema. Even if every
        # line of application code is wrong, the database will not oversell.
        CheckConstraint("quantity_reserved <= quantity_on_hand", name="reserved_within_stock"),
        Index(
            "idx_inventory_low",
            "variant_id",
            postgresql_where=text("quantity_on_hand <= reorder_point"),
        ),
    )


class InventoryMovement(HasId, HasCreatedAt, Base):
    """Append-only ledger. Never UPDATE, never DELETE."""

    __tablename__ = "inventory_movements"

    variant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("product_variants.id"))
    quantity_delta: Mapped[int]  # signed: -1 sale, +1 return, +50 restock
    reason: Mapped[str]
    reference_type: Mapped[str | None]  # 'order', 'return', 'manual'
    reference_id: Mapped[uuid.UUID | None]
    actor_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    note: Mapped[str | None]

    __table_args__ = (
        one_of("reason", *MOVEMENT_REASONS),
        Index("idx_movements_variant", "variant_id", text("created_at DESC")),
        Index("idx_movements_ref", "reference_type", "reference_id"),
    )


class InventoryReservation(HasId, HasCreatedAt, Base):
    __tablename__ = "inventory_reservations"

    variant_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("product_variants.id", ondelete="CASCADE")
    )
    checkout_session_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("checkout_sessions.id", ondelete="CASCADE")
    )
    quantity: Mapped[int]
    status: Mapped[str] = mapped_column(server_default="active")
    expires_at: Mapped[datetime]

    __table_args__ = (
        CheckConstraint("quantity > 0", name="quantity_positive"),
        one_of("status", *RESERVATION_STATUSES),
        # The sweeper's index: only live reservations are ever scanned.
        Index("idx_reservations_expiry", "expires_at", postgresql_where=text("status = 'active'")),
        Index("idx_reservations_session", "checkout_session_id"),
    )
