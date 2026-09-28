"""Shared FastAPI dependencies: services, the caller's identity, and permissions.

Authentication is stateless on the hot path (ADR-008): a :class:`Principal` is
built from the signed access token alone, with no database read. Routes that
need the live user row — profile, and later destructive admin actions —
depend on :func:`get_current_user`, which loads and re-checks it.
"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from velo.api.cookies import ACCESS_COOKIE
from velo.core.config import Settings, get_settings
from velo.core.email import Mailer, SmtpMailer
from velo.core.errors import ForbiddenError, UnauthenticatedError
from velo.core.rate_limit import RateLimiter
from velo.core.security import InvalidTokenError, decode_access_token
from velo.db.redis import get_redis
from velo.db.session import get_session
from velo.domains.identity.addresses import AddressService
from velo.domains.identity.breach import BreachChecker, NoBreachChecker, PwnedPasswordsChecker
from velo.domains.identity.permissions import Permission, has_permission
from velo.domains.identity.repository import UserRecord
from velo.domains.identity.service import AuthService, ClientInfo

SessionDep = Annotated[AsyncSession, Depends(get_session)]
SettingsDep = Annotated[Settings, Depends(get_settings)]


# ── Infrastructure ────────────────────────────────────────────────────────────


def get_rate_limiter() -> RateLimiter:
    return RateLimiter(get_redis())


def get_mailer(settings: SettingsDep) -> Mailer:
    return SmtpMailer(settings)


def get_breach_checker(settings: SettingsDep) -> BreachChecker:
    return PwnedPasswordsChecker() if settings.breach_check_enabled else NoBreachChecker()


def get_client_info(request: Request, settings: SettingsDep) -> ClientInfo:
    ip = request.client.host if request.client else ""
    if settings.trust_forwarded_for:
        forwarded = request.headers.get("X-Forwarded-For", "")
        ip = forwarded.split(",")[0].strip() or ip
    return ClientInfo(ip=ip, user_agent=request.headers.get("User-Agent"))


ClientDep = Annotated[ClientInfo, Depends(get_client_info)]


def get_auth_service(
    session: SessionDep,
    settings: SettingsDep,
    limiter: Annotated[RateLimiter, Depends(get_rate_limiter)],
    mailer: Annotated[Mailer, Depends(get_mailer)],
    breach_checker: Annotated[BreachChecker, Depends(get_breach_checker)],
) -> AuthService:
    return AuthService(session, settings, limiter, mailer, breach_checker)


def get_address_service(session: SessionDep) -> AddressService:
    return AddressService(session)


AuthServiceDep = Annotated[AuthService, Depends(get_auth_service)]
AddressServiceDep = Annotated[AddressService, Depends(get_address_service)]


# ── Identity ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Principal:
    """The authenticated caller, as the access token describes them."""

    user_id: uuid.UUID
    role: str
    session_id: uuid.UUID


def access_token_from(request: Request) -> str | None:
    """The cookie for browsers; ``Authorization: Bearer`` for mobile clients (ADR-008)."""
    authorization = request.headers.get("Authorization", "")
    if authorization.startswith("Bearer "):
        return authorization.removeprefix("Bearer ").strip() or None
    return request.cookies.get(ACCESS_COOKIE)


def get_current_principal(request: Request, settings: SettingsDep) -> Principal:
    token = access_token_from(request)
    if not token:
        raise UnauthenticatedError("Sign in to continue.")
    try:
        claims = decode_access_token(token, settings.secret_key.get_secret_value())
    except InvalidTokenError as exc:
        # Expired or forged: the same answer. The client refreshes, then retries.
        raise UnauthenticatedError("Your session has expired. Refresh and retry.") from exc
    return Principal(user_id=claims.user_id, role=claims.role, session_id=claims.session_id)


PrincipalDep = Annotated[Principal, Depends(get_current_principal)]


async def get_current_user(principal: PrincipalDep, service: AuthServiceDep) -> UserRecord:
    """The live user row — re-checks that the account still exists and is active."""
    return await service.get_user(principal.user_id)


CurrentUserDep = Annotated[UserRecord, Depends(get_current_user)]


def require_permission(permission: Permission) -> Callable[..., Awaitable[Principal]]:
    """Route protection by permission, never by role name (permissions.py)."""

    async def dependency(principal: PrincipalDep) -> Principal:
        if not has_permission(principal.role, permission):
            raise ForbiddenError("Your account does not have access to this.")
        return principal

    dependency.__name__ = f"require_{permission.value.replace(':', '_')}"
    return dependency


get_current_admin = require_permission(Permission.ADMIN_ACCESS)
AdminDep = Annotated[Principal, Depends(get_current_admin)]
