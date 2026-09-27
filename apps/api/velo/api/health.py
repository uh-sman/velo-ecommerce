"""Liveness and readiness.

These are deliberately different checks, and conflating them is an outage
waiting to happen (API-SPEC.md §2).
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Response, status
from pydantic import BaseModel
from sqlalchemy import text

from velo.core.logging import get_logger
from velo.db.redis import get_redis
from velo.db.session import get_engine

router = APIRouter(tags=["system"])
logger = get_logger(__name__)


class HealthResponse(BaseModel):
    status: Literal["ok"]


class DependencyStatus(BaseModel):
    postgres: bool
    redis: bool


class ReadyResponse(BaseModel):
    status: Literal["ready", "degraded"]
    dependencies: DependencyStatus


@router.get("/health", response_model=HealthResponse, summary="Liveness")
async def health() -> HealthResponse:
    """Is the process up?

    **This must never touch a dependency.** If it did, a brief Redis blip would
    make the orchestrator kill healthy containers and turn a degradation into an
    outage.
    """
    return HealthResponse(status="ok")


@router.get("/ready", response_model=ReadyResponse, summary="Readiness")
async def ready(response: Response) -> ReadyResponse:
    """Can this instance serve traffic — are Postgres and Redis reachable?

    Returns 503 when either is not, so the load balancer stops sending work
    here while the process stays alive and keeps retrying.
    """
    postgres_ok = await _check_postgres()
    redis_ok = await _check_redis()

    if not (postgres_ok and redis_ok):
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        logger.warning("not_ready", postgres=postgres_ok, redis=redis_ok)
        return ReadyResponse(
            status="degraded",
            dependencies=DependencyStatus(postgres=postgres_ok, redis=redis_ok),
        )

    return ReadyResponse(
        status="ready",
        dependencies=DependencyStatus(postgres=True, redis=True),
    )


async def _check_postgres() -> bool:
    try:
        async with get_engine().connect() as connection:
            await connection.execute(text("SELECT 1"))
    except Exception:
        logger.warning("postgres_unreachable", exc_info=True)
        return False
    return True


async def _check_redis() -> bool:
    try:
        return bool(await get_redis().ping())
    except Exception:
        logger.warning("redis_unreachable", exc_info=True)
        return False
