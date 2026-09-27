"""Liveness answers without touching a dependency — that is the whole point."""

from __future__ import annotations

from httpx import AsyncClient


async def test_health_reports_ok(client: AsyncClient) -> None:
    response = await client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_health_does_not_touch_postgres_or_redis(client: AsyncClient) -> None:
    """No lifespan has run, so neither client exists.

    If liveness consulted them it would raise here — and in production a brief
    Redis blip would get healthy containers killed.
    """
    response = await client.get("/health")

    assert response.status_code == 200


async def test_readiness_is_degraded_when_dependencies_are_absent(client: AsyncClient) -> None:
    response = await client.get("/ready")

    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "degraded"
    assert body["dependencies"] == {"postgres": False, "redis": False}
