"""Reading the audit log (PLANNING.md Phase 11): who did what, filtered, newest first."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import delete, literal, select, tuple_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from velo.core.errors import ConflictError, NotFoundError
from velo.domains.platform.models import AuditLog, SavedView


@dataclass(frozen=True, slots=True)
class AuditFilter:
    actor_id: uuid.UUID | None = None
    actor_email: str | None = None
    entity_type: str | None = None
    entity_id: uuid.UUID | None = None
    action: str | None = None  # an exact action, or a prefix ending in '.': 'order.'
    since: datetime | None = None
    until: datetime | None = None


@dataclass(frozen=True, slots=True)
class AuditEntry:
    id: uuid.UUID
    actor_id: uuid.UUID | None
    actor_email: str | None
    action: str
    entity_type: str
    entity_id: uuid.UUID | None
    changes: dict[str, Any] | None
    ip_address: str | None
    created_at: datetime


class AuditReader:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def search(
        self, filters: AuditFilter, *, limit: int, after: tuple[datetime, uuid.UUID] | None
    ) -> tuple[list[AuditEntry], bool]:
        query = select(AuditLog)
        if filters.actor_id:
            query = query.where(AuditLog.actor_id == filters.actor_id)
        if filters.actor_email:
            query = query.where(AuditLog.actor_email.ilike(f"%{filters.actor_email.strip()}%"))
        if filters.entity_type:
            query = query.where(AuditLog.entity_type == filters.entity_type)
        if filters.entity_id:
            query = query.where(AuditLog.entity_id == filters.entity_id)
        if filters.action:
            if filters.action.endswith("."):
                query = query.where(AuditLog.action.startswith(filters.action))
            else:
                query = query.where(AuditLog.action == filters.action)
        if filters.since:
            query = query.where(AuditLog.created_at >= filters.since)
        if filters.until:
            query = query.where(AuditLog.created_at < filters.until)
        if after is not None:
            query = query.where(
                tuple_(AuditLog.created_at, AuditLog.id)
                < tuple_(literal(after[0]), literal(after[1]))
            )
        rows = (
            await self._session.scalars(
                query.order_by(AuditLog.created_at.desc(), AuditLog.id.desc()).limit(limit + 1)
            )
        ).all()
        return [
            AuditEntry(
                id=row.id,
                actor_id=row.actor_id,
                actor_email=row.actor_email,
                action=row.action,
                entity_type=row.entity_type,
                entity_id=row.entity_id,
                changes=dict(row.changes) if row.changes else None,
                ip_address=str(row.ip_address) if row.ip_address else None,
                created_at=row.created_at,
            )
            for row in rows[:limit]
        ], len(rows) > limit


# ── Saved views ───────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class View:
    id: uuid.UUID
    scope: str
    name: str
    query: dict[str, Any]


class SavedViews:
    """A staff member's named filters. Personal: nobody else sees or edits them."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def list(self, user_id: uuid.UUID, scope: str) -> list[View]:
        rows = (
            await self._session.scalars(
                select(SavedView)
                .where(SavedView.user_id == user_id, SavedView.scope == scope)
                .order_by(SavedView.name)
            )
        ).all()
        return [View(id=r.id, scope=r.scope, name=r.name, query=dict(r.query)) for r in rows]

    async def save(self, user_id: uuid.UUID, scope: str, name: str, query: dict[str, Any]) -> View:
        row = SavedView(user_id=user_id, scope=scope, name=name, query=query)
        self._session.add(row)
        try:
            await self._session.commit()
        except IntegrityError as exc:
            await self._session.rollback()
            raise ConflictError(f"You already have a view called {name}.") from exc
        return View(id=row.id, scope=scope, name=name, query=query)

    async def delete(self, user_id: uuid.UUID, view_id: uuid.UUID) -> None:
        result = await self._session.execute(
            delete(SavedView).where(SavedView.id == view_id, SavedView.user_id == user_id)
        )
        if not result.rowcount:  # type: ignore[attr-defined]
            raise NotFoundError("No such view.")
        await self._session.commit()
