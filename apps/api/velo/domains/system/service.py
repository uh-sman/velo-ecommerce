"""System service — business logic, no HTTP.

This module must never import ``fastapi`` (ARCHITECTURE.md §3, rule 2). It
raises domain errors; the global handler decides what they mean over HTTP.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from velo import __version__
from velo.core.config import Settings
from velo.core.errors import DependencyUnavailableError
from velo.core.logging import get_logger
from velo.domains.system.repository import SystemRepository

logger = get_logger(__name__)


@dataclass(frozen=True, slots=True)
class SystemInfo:
    api_version: str
    environment: str
    database_version: str
    database_time: datetime


class SystemService:
    def __init__(self, repository: SystemRepository, settings: Settings) -> None:
        self._repository = repository
        self._settings = settings

    async def get_info(self) -> SystemInfo:
        """Read a value from Postgres and report it.

        The walking skeleton (PLANNING.md 3, M1): browser → Next.js → API →
        Postgres → back. Trivial in content, and it proves every link.
        """
        try:
            version = await self._repository.fetch_database_version()
            server_time = await self._repository.fetch_server_time()
        except Exception as exc:
            logger.warning("database_unreachable", exc_info=True)
            raise DependencyUnavailableError("The database is not reachable.") from exc

        return SystemInfo(
            api_version=__version__,
            environment=self._settings.env,
            database_version=version.split(" on ")[0],  # "PostgreSQL 16.4" is the useful part
            database_time=server_time,
        )
