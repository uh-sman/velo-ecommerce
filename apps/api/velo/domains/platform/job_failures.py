"""Background jobs that ran out of retries: kept, alerted on, and replayable (PLANNING.md 12).

ARQ retries a job that raises ``Retry``; :func:`retrying` wraps a job so a
failure is retried with exponential backoff (5 s, 10 s, 20 s, … capped at
10 minutes) and, on the last attempt, recorded here — with its arguments — and
announced as ``job.dead_lettered`` through the outbox, which emails ops. A
person fixes the cause and replays it:

    python -m velo.scripts.jobs list
    python -m velo.scripts.jobs replay <id>

Payment webhook events have their own dead-letter queue (payment_events,
PAYMENTS-AND-CHECKOUT.md §6.4) and outbox events theirs (``attempts``);
this one is for every other job.
"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from functools import wraps
from typing import Any

from arq import Retry
from sqlalchemy import Index, select, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from velo.core.logging import get_logger
from velo.db.base import Base, HasCreatedAt, HasId, JsonObject, one_of
from velo.db.session import session_scope
from velo.domains.platform.events import record_event

logger = get_logger(__name__)

MAX_TRIES = 6
JOB_FAILURE_STATUSES = ("dead", "replayed")


class JobFailure(HasId, HasCreatedAt, Base):
    __tablename__ = "job_failures"

    job: Mapped[str]
    args: Mapped[JsonObject] = mapped_column(JSONB)
    error: Mapped[str]
    attempts: Mapped[int]
    status: Mapped[str] = mapped_column(server_default="dead")
    replayed_at: Mapped[datetime | None]

    __table_args__ = (
        one_of("status", *JOB_FAILURE_STATUSES),
        Index("idx_job_failures_dead", "created_at", postgresql_where=text("status = 'dead'")),
    )


def backoff_seconds(attempt: int) -> int:
    """5, 10, 20, 40, … seconds, never more than ten minutes."""
    return int(min(600, 5 * 2 ** max(0, attempt - 1)))


Job = Callable[..., Awaitable[Any]]


def retrying(job: Job) -> Job:
    """Retry ``job`` with backoff; dead-letter it after :data:`MAX_TRIES`."""

    @wraps(job)
    async def run(ctx: dict[str, Any], *args: Any) -> Any:
        attempt = int(ctx.get("job_try", 1))
        try:
            return await job(ctx, *args)
        except Retry:
            raise
        except Exception as exc:
            if attempt < MAX_TRIES:
                logger.warning("job_retry", job=job.__name__, attempt=attempt, error=str(exc))
                raise Retry(defer=backoff_seconds(attempt)) from exc
            await dead_letter(job.__name__, list(args), exc, attempt)
            logger.error("job_dead_lettered", job=job.__name__, attempts=attempt)
            return None

    return run


async def dead_letter(job: str, args: list[Any], exc: BaseException, attempts: int) -> uuid.UUID:
    async with session_scope() as session:
        row = JobFailure(
            job=job,
            args={"args": [str(a) for a in args]},
            error=f"{type(exc).__name__}: {exc}"[:2000],
            attempts=attempts,
        )
        session.add(row)
        await session.flush()
        record_event(
            session,
            "job",
            row.id,
            "job.dead_lettered",
            {"job": job, "attempts": attempts, "error": row.error[:300]},
        )
        return row.id


async def dead_jobs(limit: int = 100) -> list[JobFailure]:
    async with session_scope() as session:
        rows = await session.scalars(
            select(JobFailure)
            .where(JobFailure.status == "dead")
            .order_by(JobFailure.created_at.desc())
            .limit(limit)
        )
        return list(rows.all())


async def mark_replayed(failure_id: uuid.UUID) -> JobFailure | None:
    async with session_scope() as session:
        row = await session.get(JobFailure, failure_id, with_for_update=True)
        if row is None or row.status != "dead":
            return None
        row.status = "replayed"
        row.replayed_at = datetime.now(UTC)
        return row
