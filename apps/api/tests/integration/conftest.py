"""Integration fixtures: a migrated test database, and a rolled-back connection per test.

The database is ``velo_test`` (or ``VELO_TEST_DATABASE_URL``), never the
development database. It is wiped and migrated once per run, so the schema
under test is exactly what ``alembic upgrade head`` produces.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from asgi_lifespan import LifespanManager
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient, Response
from redis.asyncio import Redis
from sqlalchemy import NullPool, text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession, create_async_engine

from tests.conftest import TEST_ENV, integration_enabled
from velo.core.email import InMemoryMailer

API_DIR = Path(__file__).resolve().parents[2]


def alembic_config(database_url: str) -> Config:
    # No ini file: env.py then leaves the test run's logging configuration alone.
    config = Config()
    config.set_main_option("script_location", str(API_DIR / "migrations"))
    config.set_main_option("sqlalchemy.url", database_url)
    return config


async def _wipe(database_url: str) -> None:
    engine = create_async_engine(database_url, poolclass=NullPool)
    async with engine.begin() as connection:
        await connection.execute(text("DROP SCHEMA public CASCADE"))
        await connection.execute(text("CREATE SCHEMA public"))
    await engine.dispose()


@pytest.fixture(scope="session")
def database_url() -> str:
    if not integration_enabled():
        pytest.skip("set VELO_RUN_INTEGRATION=1 with the dev containers running")
    return TEST_ENV["VELO_DATABASE_URL"]


@pytest.fixture(scope="session")
def migrated_database(database_url: str) -> str:
    """Wipe the test database and run every migration, once per test run.

    Synchronous on purpose: Alembic's env.py starts its own event loop, which
    it cannot do inside the one pytest-asyncio runs tests in.
    """
    asyncio.run(_wipe(database_url))
    command.upgrade(alembic_config(database_url), "head")
    return database_url


@pytest.fixture
async def connection(migrated_database: str) -> AsyncIterator[AsyncConnection]:
    """A connection inside a transaction that is always rolled back."""
    engine = create_async_engine(migrated_database, poolclass=NullPool)
    async with engine.connect() as conn:
        transaction = await conn.begin()
        try:
            yield conn
        finally:
            await transaction.rollback()
    await engine.dispose()


@pytest.fixture
async def session(connection: AsyncConnection) -> AsyncIterator[AsyncSession]:
    """An ORM session joined to the rolled-back transaction."""
    async with AsyncSession(
        bind=connection,
        expire_on_commit=False,
        join_transaction_mode="create_savepoint",
    ) as orm_session:
        yield orm_session


# ── HTTP: a browser-like client against the real app ─────────────────────────


class FakeBreachChecker:
    """Treats the passwords in ``breached`` as known-breached."""

    def __init__(self, breached: set[str]) -> None:
        self.breached = breached

    async def is_breached(self, password: str) -> bool:
        return password in self.breached


class Browser:
    """An httpx client that behaves like a browser against this API.

    Cookies persist across requests, and every mutating request echoes the
    ``velo_csrf`` cookie in ``X-CSRF-Token``, as the storefront does.
    """

    def __init__(self, client: AsyncClient) -> None:
        self.client = client

    @property
    def csrf(self) -> str:
        return self.client.cookies.get("velo_csrf") or ""

    async def ensure_csrf(self) -> None:
        if not self.csrf:
            await self.client.get("/api/v1/auth/csrf")

    async def get(self, path: str, **kwargs: Any) -> Response:
        return await self.client.get(path, **kwargs)

    async def send(self, method: str, path: str, **kwargs: Any) -> Response:
        await self.ensure_csrf()
        headers = {"X-CSRF-Token": self.csrf, **kwargs.pop("headers", {})}
        return await self.client.request(method, path, headers=headers, **kwargs)

    async def post(self, path: str, **kwargs: Any) -> Response:
        return await self.send("POST", path, **kwargs)

    async def patch(self, path: str, **kwargs: Any) -> Response:
        return await self.send("PATCH", path, **kwargs)

    async def delete(self, path: str, **kwargs: Any) -> Response:
        return await self.send("DELETE", path, **kwargs)


@pytest.fixture
def mailer() -> InMemoryMailer:
    return InMemoryMailer()


@pytest.fixture
def breached_passwords() -> set[str]:
    return set()


@pytest.fixture
async def live_app(
    app: FastAPI,
    migrated_database: str,
    mailer: InMemoryMailer,
    breached_passwords: set[str],
) -> AsyncIterator[FastAPI]:
    """The app with its lifespan running, email captured, and a clean slate after."""
    from velo.api.deps import get_breach_checker, get_mailer

    app.dependency_overrides[get_mailer] = lambda: mailer
    app.dependency_overrides[get_breach_checker] = lambda: FakeBreachChecker(breached_passwords)
    async with LifespanManager(app):
        yield app

    engine = create_async_engine(migrated_database, poolclass=NullPool)
    async with engine.begin() as connection:
        await connection.execute(text("TRUNCATE users CASCADE"))
    await engine.dispose()
    redis = Redis.from_url(TEST_ENV["VELO_REDIS_URL"])
    await redis.flushdb()
    await redis.aclose()


@pytest.fixture
def new_browser(live_app: FastAPI) -> Callable[[], AbstractAsyncContextManager[Browser]]:
    """A factory: each call is a separate browser with its own cookie jar."""

    @asynccontextmanager
    async def factory() -> AsyncIterator[Browser]:
        transport = ASGITransport(app=live_app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            yield Browser(client)

    return factory


@pytest.fixture
async def browser(
    new_browser: Callable[[], AbstractAsyncContextManager[Browser]],
) -> AsyncIterator[Browser]:
    async with new_browser() as instance:
        yield instance
