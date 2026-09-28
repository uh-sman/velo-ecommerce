"""Payment tables — DATA-MODEL.md §8.

Card data never touches this schema beyond a brand and the last four digits,
for display. The provider holds the card (ADR-006).
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CHAR, CheckConstraint, ForeignKey, Index, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from velo.db.base import Base, HasCreatedAt, HasId, HasTimestamps, JsonObject, one_of
from velo.db.types import MinorUnits

PROVIDERS = ("stripe", "paystack", "flutterwave")
PAYMENT_STATUSES = ("pending", "requires_action", "processing", "succeeded", "failed", "cancelled")
REFUND_REASONS = ("requested_by_customer", "duplicate", "fraudulent", "defective", "other")
REFUND_STATUSES = ("pending", "succeeded", "failed", "cancelled")
IDEMPOTENCY_STATUSES = ("in_flight", "completed", "failed")


class Payment(HasId, HasTimestamps, Base):
    __tablename__ = "payments"

    # NULL until the webhook creates the order (ADR-010).
    order_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("orders.id", ondelete="SET NULL"))
    checkout_session_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("checkout_sessions.id"))
    provider: Mapped[str]
    provider_intent_id: Mapped[str]
    provider_charge_id: Mapped[str | None]
    status: Mapped[str] = mapped_column(server_default="pending")
    amount: Mapped[int] = mapped_column(MinorUnits)
    currency: Mapped[str] = mapped_column(CHAR(3))
    amount_captured: Mapped[int] = mapped_column(MinorUnits, server_default=text("0"))
    amount_refunded: Mapped[int] = mapped_column(MinorUnits, server_default=text("0"))
    payment_method_type: Mapped[str | None]  # 'card', 'apple_pay', 'bank_transfer', …
    card_brand: Mapped[str | None]  # display only
    card_last4: Mapped[str | None] = mapped_column(CHAR(4))  # display only — NEVER the PAN
    failure_code: Mapped[str | None]
    failure_message: Mapped[str | None]

    __table_args__ = (
        one_of("provider", *PROVIDERS),
        one_of("status", *PAYMENT_STATUSES),
        CheckConstraint("amount > 0", name="amount_positive"),
        CheckConstraint("amount_captured >= 0", name="amount_captured_non_negative"),
        CheckConstraint("amount_refunded >= 0", name="amount_refunded_non_negative"),
        CheckConstraint("amount_refunded <= amount_captured", name="refund_within_capture"),
        CheckConstraint("amount_captured <= amount", name="capture_within_amount"),
        UniqueConstraint("provider", "provider_intent_id"),
        Index("idx_payments_order", "order_id"),
        # Reconciliation: stranded payments in a non-terminal state.
        Index(
            "idx_payments_pending",
            "created_at",
            postgresql_where=text("status IN ('pending','processing','requires_action')"),
        ),
    )


class PaymentEvent(HasId, Base):
    """Every provider webhook, stored before it is acted on."""

    __tablename__ = "payment_events"

    payment_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("payments.id", ondelete="SET NULL")
    )
    provider: Mapped[str]
    provider_event_id: Mapped[str]
    event_type: Mapped[str]
    payload: Mapped[JsonObject] = mapped_column(JSONB)
    signature_verified: Mapped[bool]
    processed_at: Mapped[datetime | None]
    processing_error: Mapped[str | None]
    received_at: Mapped[datetime] = mapped_column(server_default=func.now())

    __table_args__ = (
        # The entire replay defence: a duplicate delivery violates this, is
        # acknowledged with 200, and dropped.
        UniqueConstraint("provider", "provider_event_id"),
        Index(
            "idx_payment_events_unprocessed",
            "received_at",
            postgresql_where=text("processed_at IS NULL"),
        ),
    )


class Refund(HasId, HasCreatedAt, Base):
    __tablename__ = "refunds"

    payment_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("payments.id"))
    order_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("orders.id"))
    return_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("returns.id"))
    provider_refund_id: Mapped[str | None] = mapped_column(unique=True)
    amount: Mapped[int] = mapped_column(MinorUnits)
    currency: Mapped[str] = mapped_column(CHAR(3))
    reason: Mapped[str]
    status: Mapped[str] = mapped_column(server_default="pending")
    actor_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    note: Mapped[str | None]

    __table_args__ = (
        CheckConstraint("amount > 0", name="amount_positive"),
        one_of("reason", *REFUND_REASONS),
        one_of("status", *REFUND_STATUSES),
        Index("idx_refunds_order", "order_id"),
    )


class IdempotencyKey(HasCreatedAt, Base):
    __tablename__ = "idempotency_keys"

    key: Mapped[uuid.UUID] = mapped_column(primary_key=True)  # client-supplied
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    endpoint: Mapped[str]
    request_hash: Mapped[str]  # detects the same key reused with a different body
    response_status: Mapped[int | None]
    response_body: Mapped[JsonObject | None]
    status: Mapped[str] = mapped_column(server_default="in_flight")
    expires_at: Mapped[datetime] = mapped_column(server_default=text("now() + interval '24 hours'"))

    __table_args__ = (
        one_of("status", *IDEMPOTENCY_STATUSES),
        Index("idx_idem_expiry", "expires_at"),
    )
