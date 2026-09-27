"""The walking skeleton, end to end: HTTP → service → repository → Postgres.

Requires the dev containers:

    pnpm infra:up
    VELO_RUN_INTEGRATION=1 uv run pytest -m integration
"""

from __future__ import annotations

from datetime import datetime

import pytest
from httpx import AsyncClient

from tests.conftest import integration_enabled

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not integration_enabled(),
        reason="set VELO_RUN_INTEGRATION=1 with the dev containers running",
    ),
]


async def test_system_info_returns_a_value_read_from_postgres(live_client: AsyncClient) -> None:
    response = await live_client.get("/api/v1/system/info")

    assert response.status_code == 200
    body = response.json()
    assert body["database_version"].startswith("PostgreSQL")
    assert body["environment"] == "development"
    assert body["api_version"]
    # Every timestamp in this system is tz-aware (DATA-MODEL.md §1), on the wire too.
    assert datetime.fromisoformat(body["database_time"]).utcoffset() is not None


async def test_readiness_passes_when_both_dependencies_are_up(live_client: AsyncClient) -> None:
    response = await live_client.get("/ready")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ready",
        "dependencies": {"postgres": True, "redis": True},
    }
