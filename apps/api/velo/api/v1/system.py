"""System routes — HTTP concerns only.

Validates, delegates to a service, serialises the result. No business logic
lives here, and nothing here touches a repository or the ORM
(ARCHITECTURE.md §3, rule 1).
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import AwareDatetime, BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from velo.core.config import Settings, get_settings
from velo.db.session import get_session
from velo.domains.system.repository import SystemRepository
from velo.domains.system.service import SystemService

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
