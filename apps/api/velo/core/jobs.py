"""Enqueueing background work (ADR-009).

Services call :meth:`JobQueue.kick_outbox` *after* their transaction commits,
so the relay picks the new events up within moments. The kick is an
optimisation, not the guarantee: a scheduled relay runs regardless, so a lost
kick (Redis down, worker restarting) delays an event rather than dropping it.
"""

from __future__ import annotations

from typing import Any, Protocol

from arq.connections import ArqRedis, RedisSettings, create_pool

from velo.core.config import Settings
from velo.core.logging import get_logger

logger = get_logger(__name__)

RELAY_JOB = "relay_outbox"


def redis_settings(settings: Settings) -> RedisSettings:
    return RedisSettings.from_dsn(settings.redis_url)


class JobQueue(Protocol):
    async def kick_outbox(self) -> None: ...

    async def enqueue(self, function: str, *args: Any, job_id: str | None = None) -> None: ...


class ArqJobQueue:
    def __init__(self, pool: ArqRedis) -> None:
        self._pool = pool

    async def kick_outbox(self) -> None:
        # A fixed job id: while one relay run is queued, further kicks are
        # absorbed by it, so a burst of writes costs one run, not hundreds.
        await self.enqueue(RELAY_JOB, job_id=RELAY_JOB)

    async def enqueue(self, function: str, *args: Any, job_id: str | None = None) -> None:
        try:
            await self._pool.enqueue_job(function, *args, _job_id=job_id)
        except Exception as exc:  # never fail a committed write over a kick
            logger.warning("job_enqueue_failed", function=function, error=str(exc))


class NullJobQueue:
    """For tests and scripts: the scheduled relay (or the test) drains the outbox."""

    async def kick_outbox(self) -> None:
        return None

    async def enqueue(self, function: str, *args: Any, job_id: str | None = None) -> None:
        return None


_pool: ArqRedis | None = None


async def init_jobs(settings: Settings) -> None:
    global _pool
    try:
        _pool = await create_pool(redis_settings(settings))
    except Exception as exc:  # the API runs without a queue; cron catches up
        logger.warning("job_queue_unavailable", error=str(exc))
        _pool = None


async def close_jobs() -> None:
    global _pool
    if _pool is not None:
        await _pool.aclose()
    _pool = None


def get_job_queue() -> JobQueue:
    return ArqJobQueue(_pool) if _pool is not None else NullJobQueue()
