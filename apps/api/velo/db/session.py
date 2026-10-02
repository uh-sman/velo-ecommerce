"""Database engine and session lifecycle.

One engine per process, created at startup and disposed at shutdown. Sessions
are per-request and are never shared across tasks — a session is not
thread-safe and is not task-safe.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from velo.core.config import Settings

_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


def init_engine(settings: Settings) -> AsyncEngine:
    """Create the process-wide engine. Called once, from the app lifespan."""
    global _engine, _sessionmaker
    _engine = create_async_engine(
        settings.database_url,
        echo=settings.database_echo,
        pool_size=settings.database_pool_size,
        max_overflow=settings.database_max_overflow,
        pool_pre_ping=True,  # a connection killed by the server is replaced, not raised
        pool_recycle=1800,
    )
    _sessionmaker = async_sessionmaker(
        _engine,
        class_=AsyncSession,
        expire_on_commit=False,  # objects stay usable after commit, inside the request
        autoflush=False,
    )
    return _engine


async def dispose_engine() -> None:
    global _engine, _sessionmaker
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _sessionmaker = None


def get_engine() -> AsyncEngine:
    if _engine is None:
        raise RuntimeError("Database engine not initialised. init_engine() runs in the lifespan.")
    return _engine


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency: one session per request, always closed.

    The session is *not* committed here. The service layer owns the transaction
    boundary (ARCHITECTURE.md §3) — a router that commits is a router that has
    taken a decision belonging to a service.
    """
    if _sessionmaker is None:
        raise RuntimeError("Sessionmaker not initialised. init_engine() runs in the lifespan.")
    async with _sessionmaker() as session:
        yield session


@asynccontextmanager
async def session_scope() -> AsyncIterator[AsyncSession]:
    """One unit of work outside a request: commit on success, roll back on error.

    For scripts and background jobs, which have no service call to own the
    transaction. Request handlers use :func:`get_session` instead.
    """
    if _sessionmaker is None:
        raise RuntimeError("Sessionmaker not initialised. Call init_engine() first.")
    async with _sessionmaker() as session, session.begin():
        yield session


@asynccontextmanager
async def open_session() -> AsyncIterator[AsyncSession]:
    """A session whose user owns its transactions, outside a request.

    For background work that commits several times in one run — one payment
    or one checkout per transaction, so locks stay short. Anything left
    uncommitted is rolled back on close.
    """
    if _sessionmaker is None:
        raise RuntimeError("Sessionmaker not initialised. Call init_engine() first.")
    async with _sessionmaker() as session:
        yield session
