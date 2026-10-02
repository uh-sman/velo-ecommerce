"""System routes — HTTP concerns only.

Validates, delegates to a service, serialises the result. No business logic
lives here, and nothing here touches a repository or the ORM
(ARCHITECTURE.md §3, rule 1).
"""

from __future__ import annotations

from dataclasses import asdict
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends
from fastapi.responses import PlainTextResponse
from pydantic import AwareDatetime, BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from velo.api.deps import AdminDep
from velo.api.openapi import PROMETHEUS
from velo.core.config import Settings, get_settings
from velo.db.redis import get_redis
from velo.db.session import get_session
from velo.domains.system.repository import SystemRepository
from velo.domains.system.service import SystemService
from velo.domains.system.worker_health import worker_health

router = APIRouter(prefix="/system", tags=["system"])


class SystemInfoResponse(BaseModel):
    api_version: str
    environment: str
    database_version: str
    database_time: AwareDatetime


def get_system_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> SystemService:
    return SystemService(SystemRepository(session), settings)


@router.get("/info", response_model=SystemInfoResponse, summary="System information")
async def system_info(
    service: Annotated[SystemService, Depends(get_system_service)],
) -> SystemInfoResponse:
    """Values read from Postgres, for the walking skeleton and for support."""
    info = await service.get_info()
    return SystemInfoResponse(
        api_version=info.api_version,
        environment=info.environment,
        database_version=info.database_version,
        database_time=info.database_time,
    )


class WorkerHealthResponse(BaseModel):
    healthy: bool
    heartbeat_at: AwareDatetime | None
    heartbeat_age_seconds: float | None
    queue_depth: int
    outbox_pending: int
    outbox_stuck: int
    dead_jobs: int
    dead_payment_events: int
    emails_failed_24h: int


@router.get(
    "/worker",
    response_model=WorkerHealthResponse,
    summary="Worker liveness, queue depth and backlogs (staff; ?format=prometheus)",
    responses=PROMETHEUS,
)
async def worker(
    _: AdminDep,
    session: Annotated[AsyncSession, Depends(get_session)],
    format: Literal["json", "prometheus"] = "json",  # noqa: A002 — the query parameter's name
) -> Any:
    health = await worker_health(session, get_redis())
    if format == "prometheus":
        return PlainTextResponse(health.prometheus(), media_type="text/plain; version=0.0.4")
    return WorkerHealthResponse(**asdict(health))
