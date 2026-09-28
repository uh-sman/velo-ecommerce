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

from velo.api.cookies import ACCESS_COOKIE, CART_COOKIE
from velo.core.config import Settings, get_settings
from velo.core.email import Mailer, SmtpMailer
from velo.core.errors import ForbiddenError, UnauthenticatedError
from velo.core.jobs import JobQueue, get_job_queue
from velo.core.meili import MeiliClient
from velo.core.rate_limit import RateLimiter
from velo.core.security import InvalidTokenError, decode_access_token
from velo.core.storage import MediaStorage
from velo.db.redis import get_redis
from velo.db.session import get_session
from velo.domains.cart.service import CartOwner, CartService
from velo.domains.catalog.admin import CatalogAdminService
from velo.domains.catalog.cache import CatalogCache
from velo.domains.catalog.csv_io import CatalogCsvService
from velo.domains.catalog.reviews import ReviewService
from velo.domains.catalog.search import SearchService
from velo.domains.catalog.service import CatalogService
from velo.domains.discounts.service import DiscountService
from velo.domains.identity.addresses import AddressService
from velo.domains.identity.breach import BreachChecker, NoBreachChecker, PwnedPasswordsChecker
from velo.domains.identity.permissions import Permission, has_permission
from velo.domains.identity.repository import UserRecord
from velo.domains.identity.service import AuthService, ClientInfo
from velo.domains.inventory.service import InventoryService
from velo.domains.platform.events import Actor
from velo.domains.shipping.service import RulesTaxProvider, ShippingService

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


# ── Catalog, inventory, search ────────────────────────────────────────────────

_meili: MeiliClient | None = None
_storage: MediaStorage | None = None


def get_meili(settings: SettingsDep) -> MeiliClient:
    """One client per process: it holds a connection pool."""
    global _meili
    if _meili is None:
        _meili = MeiliClient(settings)
    return _meili


async def close_meili() -> None:
    global _meili
    if _meili is not None:
        await _meili.aclose()
    _meili = None


def get_storage(settings: SettingsDep) -> MediaStorage:
    global _storage
    if _storage is None:
        _storage = MediaStorage(settings)
    return _storage


def get_catalog_cache(settings: SettingsDep) -> CatalogCache:
    return CatalogCache(get_redis(), settings.catalog_cache_ttl_seconds)


CacheDep = Annotated[CatalogCache, Depends(get_catalog_cache)]
JobsDep = Annotated[JobQueue, Depends(get_job_queue)]


def get_inventory_service(
    session: SessionDep, settings: SettingsDep, jobs: JobsDep
) -> InventoryService:
    return InventoryService(session, jobs=jobs, display_threshold=settings.stock_display_threshold)


InventoryServiceDep = Annotated[InventoryService, Depends(get_inventory_service)]


def get_catalog_service(
    session: SessionDep, cache: CacheDep, inventory: InventoryServiceDep
) -> CatalogService:
    return CatalogService(session, cache, inventory)


def get_catalog_admin_service(
    session: SessionDep,
    cache: CacheDep,
    inventory: InventoryServiceDep,
    jobs: JobsDep,
    storage: Annotated[MediaStorage, Depends(get_storage)],
) -> CatalogAdminService:
    return CatalogAdminService(
        session, cache=cache, inventory=inventory, jobs=jobs, storage=storage
    )


def get_csv_service(
    session: SessionDep, cache: CacheDep, inventory: InventoryServiceDep, jobs: JobsDep
) -> CatalogCsvService:
    return CatalogCsvService(session, cache=cache, inventory=inventory, jobs=jobs)


def get_review_service(session: SessionDep, cache: CacheDep, jobs: JobsDep) -> ReviewService:
    return ReviewService(session, cache, jobs)


def get_search_service(
    session: SessionDep, settings: SettingsDep, meili: Annotated[MeiliClient, Depends(get_meili)]
) -> SearchService:
    return SearchService(session, meili, settings.meilisearch_index)


CatalogServiceDep = Annotated[CatalogService, Depends(get_catalog_service)]
CatalogAdminDep = Annotated[CatalogAdminService, Depends(get_catalog_admin_service)]
CsvServiceDep = Annotated[CatalogCsvService, Depends(get_csv_service)]
ReviewServiceDep = Annotated[ReviewService, Depends(get_review_service)]
SearchServiceDep = Annotated[SearchService, Depends(get_search_service)]


def optional_principal(request: Request, settings: SettingsDep) -> Principal | None:
    """The caller if signed in with a valid token, else None — for routes open to both."""
    try:
        return get_current_principal(request, settings)
    except UnauthenticatedError:
        return None


OptionalPrincipalDep = Annotated[Principal | None, Depends(optional_principal)]


def staff_actor(
    permission: Permission,
) -> Callable[..., Awaitable[Actor]]:
    """An admin mutation's actor: permission checked, live account re-read, origin recorded."""
    guard = require_permission(permission)

    # The guard is a default, not an Annotated[...]: with postponed annotations
    # FastAPI resolves annotation strings from module globals, where a local
    # like `guard` does not exist.
    async def dependency(
        user: CurrentUserDep,
        client: ClientDep,
        principal: Principal = Depends(guard),  # noqa: B008
    ) -> Actor:
        del principal  # the guard has done its job
        return Actor(user_id=user.id, email=user.email, ip=client.ip, user_agent=client.user_agent)

    dependency.__name__ = f"actor_{permission.value.replace(':', '_')}"
    return dependency


CatalogWriterDep = Annotated[Actor, Depends(staff_actor(Permission.CATALOG_WRITE))]
InventoryWriterDep = Annotated[Actor, Depends(staff_actor(Permission.INVENTORY_WRITE))]
CatalogReaderDep = Annotated[Principal, Depends(require_permission(Permission.ADMIN_ACCESS))]


# ── Cart ──────────────────────────────────────────────────────────────────────


def get_cart_service(
    session: SessionDep,
    settings: SettingsDep,
    catalog: CatalogServiceDep,
    inventory: InventoryServiceDep,
) -> CartService:
    return CartService(
        session,
        catalog=catalog,
        inventory=inventory,
        discounts=DiscountService(session),
        shipping=ShippingService(session),
        tax=RulesTaxProvider(session),
        currency=settings.currency,
    )


CartServiceDep = Annotated[CartService, Depends(get_cart_service)]


def get_cart_owner(request: Request, principal: OptionalPrincipalDep) -> CartOwner:
    """A signed-in user's cart, else the browser's guest cart."""
    if principal is not None:
        return CartOwner(user_id=principal.user_id)
    return CartOwner(guest_token=request.cookies.get(CART_COOKIE))


CartOwnerDep = Annotated[CartOwner, Depends(get_cart_owner)]
