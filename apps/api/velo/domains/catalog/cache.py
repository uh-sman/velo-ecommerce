"""Read-through Redis cache for catalog reads.

- **Product detail** is cached per slug and deleted when that product, one of
  its variants, or its stock changes.
- **Everything else** — listings, the category tree, collections — carries a
  catalog-wide version in its key. Any catalog write bumps the version, so
  stale entries are never read again and expire on their own. One integer
  replaces tracking which of thousands of filter combinations a write touched.

Invalidation is event-driven: the outbox relay calls :meth:`invalidate_product`
and :meth:`bump` for every catalog and inventory event (ADR-009), and the
admin service calls them directly after commit so an editor sees their change
at once.

Redis failing is a cache miss, never an error (DISCOVERY.md §7.2: fail open on
browsing).
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

from redis.asyncio import Redis
from redis.exceptions import RedisError

from velo.core.logging import get_logger

logger = get_logger(__name__)

PREFIX = "velo:catalog"
VERSION_KEY = f"{PREFIX}:version"

T = TypeVar("T")


class CatalogCache:
    def __init__(self, redis: Redis | None, ttl_seconds: int) -> None:
        self._redis = redis if ttl_seconds > 0 else None
        self._ttl = ttl_seconds

    @staticmethod
    def product_key(slug: str) -> str:
        return f"{PREFIX}:product:{slug}"

    async def _version(self) -> str:
        assert self._redis is not None
        return str(await self._redis.get(VERSION_KEY) or "0")

    async def versioned_key(self, name: str) -> str | None:
        if self._redis is None:
            return None
        try:
            return f"{PREFIX}:v{await self._version()}:{name}"
        except RedisError as exc:
            logger.warning("catalog_cache_unavailable", error=str(exc))
            return None

    async def get_or_load(
        self,
        key: str | None,
        load: Callable[[], Awaitable[T]],
        dump: Callable[[T], Any],
        restore: Callable[[Any], T],
    ) -> T:
        """The cached value under ``key``, or ``load()`` stored for next time."""
        if self._redis is None or key is None:
            return await load()
        try:
            cached = await self._redis.get(key)
        except RedisError as exc:
            logger.warning("catalog_cache_unavailable", error=str(exc))
            return await load()
        if cached is not None:
            return restore(json.loads(cached))
        value = await load()
        if value is not None:
            try:
                await self._redis.set(key, json.dumps(dump(value), default=str), ex=self._ttl)
            except RedisError as exc:
                logger.warning("catalog_cache_write_failed", error=str(exc))
        return value

    async def invalidate_product(self, *slugs: str) -> None:
        if self._redis is None or not slugs:
            return
        try:
            await self._redis.delete(*(self.product_key(slug) for slug in slugs))
        except RedisError as exc:
            logger.warning("catalog_cache_invalidate_failed", error=str(exc))

    async def bump(self) -> None:
        if self._redis is None:
            return
        try:
            await self._redis.incr(VERSION_KEY)
        except RedisError as exc:
            logger.warning("catalog_cache_invalidate_failed", error=str(exc))
