"""Migrations: head builds the documented schema, base removes it, and the models agree.

PLANNING.md Phase 4, Definition of Done: ``alembic upgrade head`` on an empty
database produces the full schema; ``alembic downgrade base`` reverses it
cleanly; the models (and so DATA-MODEL.md) match the migrations exactly.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import NullPool, text
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine

from tests.integration.conftest import alembic_config
from velo.db.alembic_hooks import include_object
from velo.db.models import Base

pytestmark = pytest.mark.integration


async def _public_tables(connection: AsyncConnection) -> set[str]:
    result = await connection.execute(
        text("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
    )
    return set(result.scalars()) - {"alembic_version"}


async def test_head_creates_every_model_table(connection: AsyncConnection) -> None:
    assert await _public_tables(connection) == set(Base.metadata.tables)


def _diff(sync_connection: Connection) -> list[Any]:
    context = MigrationContext.configure(
        sync_connection,
        opts={
            "compare_type": True,
            "compare_server_default": True,
            "include_object": include_object,
        },
    )
    return list(compare_metadata(context, Base.metadata))


async def test_models_match_the_migrations_exactly(connection: AsyncConnection) -> None:
    """The same comparison as ``alembic check``: columns, types, defaults, indexes, constraints."""
    assert await connection.run_sync(_diff) == []


async def test_the_full_text_index_exists(connection: AsyncConnection) -> None:
    """Excluded from the comparison above (alembic_hooks.EXPRESSION_INDEXES), so checked here."""
    definition = await connection.scalar(
        text("SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_products_fts'")
    )
    assert definition is not None
    assert "USING gin (to_tsvector('english'::regconfig" in definition


async def test_database_generates_uuidv7_keys(connection: AsyncConnection) -> None:
    """Rows inserted outside the ORM still get time-ordered keys."""
    first = await connection.scalar(text("SELECT uuidv7()"))
    await asyncio.sleep(0.002)
    second = await connection.scalar(text("SELECT uuidv7()"))

    assert isinstance(first, uuid.UUID)
    assert first.version == 7
    assert first < second


async def test_downgrade_to_base_removes_everything_and_upgrade_restores_it(
    migrated_database: str,
) -> None:
    config = alembic_config(migrated_database)
    engine = create_async_engine(migrated_database, poolclass=NullPool)
    try:
        await asyncio.to_thread(command.downgrade, config, "base")
        async with engine.connect() as connection:
            assert await _public_tables(connection) == set()
            assert (
                await connection.scalar(
                    text("SELECT count(*) FROM pg_proc WHERE proname = 'uuidv7'")
                )
                == 0
            )
            extensions = set(
                (await connection.execute(text("SELECT extname FROM pg_extension"))).scalars()
            )
            assert {"citext", "ltree"}.isdisjoint(extensions)
    finally:
        # Restore the schema for the tests that follow, even if an assertion failed.
        await asyncio.to_thread(command.upgrade, config, "head")

    async with engine.connect() as connection:
        assert await _public_tables(connection) == set(Base.metadata.tables)
        assert await connection.run_sync(_diff) == []
    await engine.dispose()
