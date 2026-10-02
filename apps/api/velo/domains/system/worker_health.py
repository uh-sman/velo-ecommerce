"""Is the worker alive, and is work piling up? (PLANNING.md Phase 12.)

Read from what the worker leaves behind rather than by asking it: the
heartbeat key it refreshes every 30 seconds (expiring after 2 minutes), the
ARQ queue in Redis, and the backlogs in Postgres — unpublished outbox events,
dead-lettered jobs and payment events, failed emails. The same numbers are
offered in Prometheus' text format for monitoring (Phase 16 scrapes them).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from redis.asyncio import Redis
from sqlalchemy import column, func, select, table
from sqlalchemy.ext.asyncio import AsyncSession

from velo.domains.platform.events import MAX_ATTEMPTS

HEARTBEAT_KEY = "velo:worker:heartbeat"
ARQ_QUEUE_KEY = "arq:queue"
STALE_AFTER = timedelta(seconds=90)

_outbox = table("outbox_events", column("published_at"), column("attempts"))
_jobs = table("job_failures", column("status"))
_events = table("payment_events", column("dead_lettered_at"), column("processed_at"))
_emails = table("sent_emails", column("status"), column("created_at"))


@dataclass(frozen=True, slots=True)
class WorkerHealth:
    healthy: bool
    heartbeat_at: datetime | None
    heartbeat_age_seconds: float | None
    queue_depth: int
    outbox_pending: int
    outbox_stuck: int
    dead_jobs: int
    dead_payment_events: int
    emails_failed_24h: int

    def prometheus(self) -> str:
        """Gauges in Prometheus' text exposition format."""
        gauges = {
            "velo_worker_up": int(self.healthy),
            "velo_worker_heartbeat_age_seconds": self.heartbeat_age_seconds or -1,
            "velo_queue_depth": self.queue_depth,
            "velo_outbox_pending": self.outbox_pending,
            "velo_outbox_stuck": self.outbox_stuck,
            "velo_jobs_dead": self.dead_jobs,
            "velo_payment_events_dead": self.dead_payment_events,
            "velo_emails_failed_24h": self.emails_failed_24h,
        }
        return "".join(f"# TYPE {name} gauge\n{name} {value}\n" for name, value in gauges.items())


async def worker_health(session: AsyncSession, redis: Redis) -> WorkerHealth:
    now = datetime.now(UTC)
    raw = await redis.get(HEARTBEAT_KEY)
    beat = datetime.fromisoformat(raw.decode() if isinstance(raw, bytes) else raw) if raw else None
    age = (now - beat).total_seconds() if beat else None
    depth = int(await redis.zcard(ARQ_QUEUE_KEY))

    async def count(statement: object) -> int:
        return int(await session.scalar(statement) or 0)  # type: ignore[call-overload]

    pending = await count(
        select(func.count())
        .select_from(_outbox)
        .where(_outbox.c.published_at.is_(None), _outbox.c.attempts < MAX_ATTEMPTS)
    )
    stuck = await count(
        select(func.count())
        .select_from(_outbox)
        .where(_outbox.c.published_at.is_(None), _outbox.c.attempts >= MAX_ATTEMPTS)
    )
    dead_jobs = await count(select(func.count()).select_from(_jobs).where(_jobs.c.status == "dead"))
    dead_events = await count(
        select(func.count())
        .select_from(_events)
        .where(_events.c.dead_lettered_at.is_not(None), _events.c.processed_at.is_(None))
    )
    failed_emails = await count(
        select(func.count())
        .select_from(_emails)
        .where(_emails.c.status == "failed", _emails.c.created_at > now - timedelta(days=1))
    )
    return WorkerHealth(
        healthy=age is not None and age < STALE_AFTER.total_seconds(),
        heartbeat_at=beat,
        heartbeat_age_seconds=round(age, 1) if age is not None else None,
        queue_depth=depth,
        outbox_pending=pending,
        outbox_stuck=stuck,
        dead_jobs=dead_jobs,
        dead_payment_events=dead_events,
        emails_failed_24h=failed_emails,
    )
