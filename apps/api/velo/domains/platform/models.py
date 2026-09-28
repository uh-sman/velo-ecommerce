"""Platform tables — DATA-MODEL.md §10: the outbox, outbound webhooks, and the audit log."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, Index, text
from sqlalchemy.dialects.postgresql import CITEXT, INET, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from velo.db.base import Base, HasCreatedAt, HasId, JsonObject, one_of

DELIVERY_STATUSES = ("pending", "delivered", "failed", "dead_lettered")


class OutboxEvent(HasId, HasCreatedAt, Base):
    """Written in the same transaction as the change it announces."""

    __tablename__ = "outbox_events"

    aggregate_type: Mapped[str]  # 'order', 'product', 'payment'
    aggregate_id: Mapped[uuid.UUID]
    event_type: Mapped[str]  # 'order.created'
    payload: Mapped[JsonObject] = mapped_column(JSONB)
    published_at: Mapped[datetime | None]
    attempts: Mapped[int] = mapped_column(server_default=text("0"))
    last_error: Mapped[str | None]

    __table_args__ = (
        # The relay's only query.
        Index(
            "idx_outbox_unpublished", "created_at", postgresql_where=text("published_at IS NULL")
        ),
    )


class WebhookDelivery(HasId, HasCreatedAt, Base):
    __tablename__ = "webhook_deliveries"

    endpoint_url: Mapped[str]
    event_type: Mapped[str]
    payload: Mapped[JsonObject] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(server_default="pending")
    attempts: Mapped[int] = mapped_column(server_default=text("0"))
    response_code: Mapped[int | None]
    next_retry_at: Mapped[datetime | None]

    __table_args__ = (one_of("status", *DELIVERY_STATUSES),)


class AuditLog(HasId, HasCreatedAt, Base):
    __tablename__ = "audit_log"

    actor_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    actor_email: Mapped[str | None] = mapped_column(CITEXT)  # survives the user's deletion
    action: Mapped[str]  # 'product.updated', 'refund.issued'
    entity_type: Mapped[str]
    entity_id: Mapped[uuid.UUID | None]
    changes: Mapped[JsonObject | None]  # {"field": {"from": x, "to": y}}
    ip_address: Mapped[str | None] = mapped_column(INET)
    user_agent: Mapped[str | None]

    __table_args__ = (
        Index("idx_audit_entity", "entity_type", "entity_id", text("created_at DESC")),
        Index("idx_audit_actor", "actor_id", text("created_at DESC")),
    )
