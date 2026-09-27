"""Redis client lifecycle.

Redis is a cache and a counter store, never a system of record (ADR-002). Where
it is unavailable the API degrades — cache misses fall through to Postgres and
rate limiting fails open — except for inventory reservations, which fail closed
(DISCOVERY.md §7.2: fail closed on money, fail open on browsing).
"""

from __future__ import annotations

from redis.asyncio import Redis

from velo.core.config import Settings

_client: Redis | None = None


def init_redis(settings: Settings) -> Redis:
    global _client
    _client = Redis.from_url(
        settings.redis_url,
        encoding="utf-8",
        decode_responses=True,
        socket_connect_timeout=2,
        socket_timeout=2,
        health_check_interval=30,
    )
    return _client


async def close_redis() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
    _client = None


def get_redis() -> Redis:
    if _client is None:
        raise RuntimeError("Redis client not initialised. init_redis() runs in the lifespan.")
    return _client
