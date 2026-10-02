"""Email tables (PLANNING.md Phase 12): what was sent, who opted out, and cart reminders.

``sent_emails`` is both the log and the exactly-once guard: a customer-facing
event sends with a ``dedupe_key`` (``order.created:<order id>``), and a key
already sent is never sent again — however many times the outbox relays the
event. The provider's delivery webhook updates the same row.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, Index, func, text
from sqlalchemy.dialects.postgresql import CITEXT
from sqlalchemy.orm import Mapped, mapped_column

from velo.db.base import Base, HasCreatedAt, HasId, one_of

EMAIL_STATUSES = ("queued", "sent", "delivered", "bounced", "complained", "failed", "skipped")


class SentEmail(HasId, HasCreatedAt, Base):
    __tablename__ = "sent_emails"

    kind: Mapped[str]  # 'order_confirmed', 'cart_recovery', …
    to_email: Mapped[str] = mapped_column(CITEXT)
    subject: Mapped[str]
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    # Unique when present: the same event never emails twice.
    dedupe_key: Mapped[str | None] = mapped_column(unique=True)
    status: Mapped[str] = mapped_column(server_default="queued")
    skip_reason: Mapped[str | None]  # 'unsubscribed', 'rate_limited'
    provider: Mapped[str | None]  # 'smtp', 'resend'
    provider_message_id: Mapped[str | None] = mapped_column(unique=True)
    error: Mapped[str | None]
    sent_at: Mapped[datetime | None]
    delivered_at: Mapped[datetime | None]
    bounced_at: Mapped[datetime | None]

    __table_args__ = (
        one_of("status", *EMAIL_STATUSES),
        Index("idx_sent_emails_to", "to_email", text("created_at DESC")),
    )


class EmailPreference(Base):
    """Opt-outs, by address — so a guest can unsubscribe too. No row: the defaults."""

    __tablename__ = "email_preferences"

    email: Mapped[str] = mapped_column(CITEXT, primary_key=True)
    cart_reminders: Mapped[bool] = mapped_column(server_default=text("true"))
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now())


class CartReminder(Base):
    """Where a cart is in the abandoned-cart sequence (1 h, 24 h, 72 h)."""

    __tablename__ = "cart_reminders"

    cart_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("carts.id", ondelete="CASCADE"), primary_key=True
    )
    email: Mapped[str] = mapped_column(CITEXT)
    step: Mapped[int] = mapped_column(server_default=text("0"))
    # The cart's last activity when the sequence started; newer activity restarts it.
    activity_at: Mapped[datetime]
    last_sent_at: Mapped[datetime | None]
