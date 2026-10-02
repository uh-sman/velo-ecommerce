"""Shared test fixtures.

Unit tests touch nothing external. Integration tests need the containers from
``docker/docker-compose.dev.yml`` and are marked ``integration`` so they can be
deselected.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator, Iterator

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from velo.core.config import Settings, get_settings

TEST_ENV = {
    "VELO_ENV": "development",
    "VELO_DEBUG": "true",
    "VELO_SECRET_KEY": "test-secret-key-that-is-long-enough-for-validation",
    # Separate override variables, so a developer's VELO_DATABASE_URL (which
    # points at dev data) can never leak into the test run.
    "VELO_DATABASE_URL": os.environ.get(
        "VELO_TEST_DATABASE_URL", "postgresql+asyncpg://velo:velo@localhost:5432/velo_test"
    ),
    "VELO_REDIS_URL": os.environ.get("VELO_TEST_REDIS_URL", "redis://localhost:6379/1"),
    "VELO_CORS_ORIGINS": "http://localhost:3000",
    "VELO_COOKIE_SECURE": "false",
    # Never the developer's index: the search tests create and delete this one.
    "VELO_MEILISEARCH_INDEX": "products_test",
    "VELO_OPS_ALERT_EMAIL": "ops@example.com",
    "VELO_TRACKING_WEBHOOK_SECRET": "tracking-webhook-secret",
}


@pytest.fixture(autouse=True)
def _clean_settings_cache() -> Iterator[None]:
    """Settings are cached; a test that changes the environment must not leak."""
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def test_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key, value in TEST_ENV.items():
        monkeypatch.setenv(key, value)


@pytest.fixture
def settings(test_env: None) -> Settings:
    return Settings()


@pytest.fixture
def app(settings: Settings) -> FastAPI:
    from velo.main import create_app

    return create_app(settings)


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    """An HTTP client that does not start the lifespan.

    Routes needing Postgres or Redis are integration tests and use
    ``live_client`` instead; this one exercises the HTTP layer alone.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as http_client:
        yield http_client


@pytest.fixture
async def live_client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    """A client with the lifespan running — requires the dev containers."""
    from asgi_lifespan import LifespanManager

    async with LifespanManager(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as http_client:
            yield http_client


def integration_enabled() -> bool:
    return os.environ.get("VELO_RUN_INTEGRATION") == "1"
