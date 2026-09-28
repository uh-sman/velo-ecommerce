"""Alembic environment — async, driven by the application's settings.

Two entry points:

* ``uv run alembic upgrade head`` — opens its own async engine on
  ``VELO_DATABASE_URL``.
* Programmatic, from the test suite — the caller passes an open synchronous
  connection in ``config.attributes["connection"]`` and this module uses it, so
  tests can run migrations inside their own event loop.
"""

from __future__ import annotations

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import create_async_engine

from velo.db.alembic_hooks import include_object, render_item
from velo.db.models import Base

config = context.config
if config.config_file_name is not None and not config.attributes.get("connection"):
    fileConfig(config.config_file_name, disable_existing_loggers=False)
target_metadata = Base.metadata


def _database_url() -> str:
    url = config.get_main_option("sqlalchemy.url")
    if url:
        return url
    from velo.core.config import get_settings

    return get_settings().database_url


def _configure(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        compare_type=True,
        compare_server_default=True,
        render_item=render_item,
        include_object=include_object,
        # One transaction for the whole run: a failed migration leaves nothing
        # half-applied. Postgres DDL is transactional, so this is real.
        transaction_per_migration=False,
    )


def _run_migrations(connection: Connection) -> None:
    _configure(connection)
    with context.begin_transaction():
        context.run_migrations()


async def _run_async() -> None:
    engine = create_async_engine(_database_url(), poolclass=pool.NullPool)
    async with engine.connect() as connection:
        await connection.run_sync(_run_migrations)
    await engine.dispose()


def run_migrations_offline() -> None:
    """``alembic upgrade head --sql``: emit the SQL for review instead of running it."""
    context.configure(
        url=_database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_item=render_item,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connection = config.attributes.get("connection")
    if connection is not None:
        _run_migrations(connection)
    else:
        asyncio.run(_run_async())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
