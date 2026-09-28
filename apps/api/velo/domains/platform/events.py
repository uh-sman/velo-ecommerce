"""The outbox and the audit log — the platform's service interface for other domains.

**Outbox.** A domain that changes something other processes care about (the
search index, an email, a cache) records an event *in the same transaction* as
the change. The worker relays it afterwards (ADR-009). The change and the
announcement commit together or not at all, so the index can lag but never
miss a write.

**Audit log.** Every admin mutation records who did what, with the fields that
changed (API-SPEC.md §2, "Admin").
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from velo.domains.platform.models import AuditLog, OutboxEvent

# How many times the relay retries an event before it stops picking it up.
MAX_ATTEMPTS = 10


@dataclass(frozen=True, slots=True)
class Actor:
    """Who made an admin change, and from where."""

    user_id: uuid.UUID | None
    email: str | None = None
    ip: str | None = None
    user_agent: str | None = None


@dataclass(frozen=True, slots=True)
class PendingEvent:
    id: uuid.UUID
    aggregate_type: str
    aggregate_id: uuid.UUID
    event_type: str
    payload: dict[str, Any]
    attempts: int
    created_at: datetime


def record_event(
    session: AsyncSession,
    aggregate_type: str,
    aggregate_id: uuid.UUID,
    event_type: str,
    payload: dict[str, Any] | None = None,
) -> None:
    """Add an event to the caller's transaction. It is visible to the relay on commit."""
    session.add(
        OutboxEvent(
            aggregate_type=aggregate_type,
            aggregate_id=aggregate_id,
            event_type=event_type,
            payload=payload or {},
        )
    )


def diff(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    """``{"field": {"from": x, "to": y}}`` for every field whose value changed."""
    return {
        key: {"from": _jsonable(before.get(key)), "to": _jsonable(value)}
        for key, value in after.items()
        if before.get(key) != value
    }


def _jsonable(value: Any) -> Any:
    if isinstance(value, uuid.UUID | datetime):
        return str(value)
    return value


def record_audit(
    session: AsyncSession,
    actor: Actor,
    action: str,
    entity_type: str,
    entity_id: uuid.UUID | None,
    changes: dict[str, Any] | None = None,
) -> None:
    session.add(
        AuditLog(
            actor_id=actor.user_id,
            actor_email=actor.email,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            changes=changes,
            ip_address=actor.ip or None,
            user_agent=actor.user_agent,
        )
    )


class OutboxRepository:
    """The relay's side: claim unpublished events, then mark them done or failed."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def claim(self, limit: int = 100) -> list[PendingEvent]:
        """Oldest unpublished events, locked so two relays never process the same one."""
        rows = (
            await self._session.scalars(
                select(OutboxEvent)
                .where(OutboxEvent.published_at.is_(None), OutboxEvent.attempts < MAX_ATTEMPTS)
                .order_by(OutboxEvent.created_at)
                .limit(limit)
                .with_for_update(skip_locked=True)
            )
        ).all()
        return [
            PendingEvent(
                id=row.id,
                aggregate_type=row.aggregate_type,
                aggregate_id=row.aggregate_id,
                event_type=row.event_type,
                payload=dict(row.payload),
                attempts=row.attempts,
                created_at=row.created_at,
            )
            for row in rows
        ]

    async def mark_published(self, event_ids: list[uuid.UUID]) -> None:
        if event_ids:
            await self._session.execute(
                update(OutboxEvent)
                .where(OutboxEvent.id.in_(event_ids))
                .values(published_at=func.now())
            )

    async def mark_failed(self, event_id: uuid.UUID, error: str) -> None:
        await self._session.execute(
            update(OutboxEvent)
            .where(OutboxEvent.id == event_id)
            .values(attempts=OutboxEvent.attempts + 1, last_error=error[:2000])
        )

    async def since(self, created_after: datetime) -> list[PendingEvent]:
        """Every event recorded after a moment, published or not. For a reindex's catch-up."""
        rows = (
            await self._session.scalars(
                select(OutboxEvent)
                .where(OutboxEvent.created_at >= created_after)
                .order_by(OutboxEvent.created_at)
            )
        ).all()
        return [
            PendingEvent(
                id=row.id,
                aggregate_type=row.aggregate_type,
                aggregate_id=row.aggregate_id,
                event_type=row.event_type,
                payload=dict(row.payload),
                attempts=row.attempts,
                created_at=row.created_at,
            )
            for row in rows
        ]

    async def backlog(self) -> int:
        count = await self._session.scalar(
            select(func.count())
            .select_from(OutboxEvent)
            .where(OutboxEvent.published_at.is_(None), OutboxEvent.attempts < MAX_ATTEMPTS)
        )
        return int(count or 0)
