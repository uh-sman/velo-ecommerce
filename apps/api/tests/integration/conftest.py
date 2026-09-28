"""Integration fixtures: a migrated test database, and a rolled-back connection per test.

The database is ``velo_test`` (or ``VELO_TEST_DATABASE_URL``), never the
development database. It is wiped and migrated once per run, so the schema
under test is exactly what ``alembic upgrade head`` produces.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import NullPool, text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession, create_async_engine

from tests.conftest import TEST_ENV, integration_enabled

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
