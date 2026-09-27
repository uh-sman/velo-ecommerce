"""System repository — data access only.

The first repository in the codebase, and the template for every later one: it
runs queries and returns plain values. No business rules, no HTTP, no `if` that
encodes a policy (ARCHITECTURE.md §3, rule 3).
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


class SystemRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def fetch_database_version(self) -> str:
        """The server version string, proving a real round trip to Postgres."""
        result = await self._session.execute(text("SELECT version()"))
        return str(result.scalar_one())

    async def fetch_server_time(self) -> datetime:
        """Tz-aware. ``now()`` is ``timestamptz``; ``AT TIME ZONE`` would strip the offset."""
        result = await self._session.execute(text("SELECT now()"))
        value: datetime = result.scalar_one()
        return value
