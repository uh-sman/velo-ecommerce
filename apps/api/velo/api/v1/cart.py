"""/cart — the shopper's cart, priced on every response (API-SPEC.md §2, "Cart").

Every response is the whole cart, re-priced from the catalog. The optional
``country``/``region``/``postal_code`` query parameters estimate shipping and
tax; without them both are ``null``. ``shipping_rate`` picks a rate from the
estimate's options.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response

from velo.api.cookies import CART_COOKIE, clear_cart_cookie, set_cart_cookie
from velo.api.deps import (
    CartOwnerDep,
    CartServiceDep,
    ClientDep,
    PrincipalDep,
    SettingsDep,
    get_rate_limiter,
)
from velo.core import rate_limit
from velo.core.config import Settings
from velo.core.errors import RateLimitedError
from velo.core.rate_limit import RateLimiter
from velo.domains.cart.service import CartResult, Estimate
from velo.domains.cart.views import AddItem, ApplyCode, CartView, SetQuantity
from velo.domains.shipping.service import Address

router = APIRouter(prefix="/cart", tags=["cart"])

Limiter = Annotated[RateLimiter, Depends(get_rate_limiter)]


def estimate(
    country: Annotated[str | None, Query(pattern=r"^[A-Za-z]{2}$")] = None,
    region: Annotated[str | None, Query(max_length=50)] = None,
    postal_code: Annotated[str | None, Query(max_length=20)] = None,
    shipping_rate: uuid.UUID | None = None,
) -> Estimate:
    address = (
        Address(country_code=country, region=region, postal_code=postal_code) if country else None
    )
    return Estimate(address=address, shipping_rate_id=shipping_rate)


EstimateDep = Annotated[Estimate, Depends(estimate)]


async def limit_mutations(
    owner: CartOwnerDep, client: ClientDep, response: Response, limiter: Limiter
) -> None:
    subject = str(owner.user_id or owner.guest_token or client.ip)
    status = await limiter.hit(rate_limit.CART_MUTATIONS, subject)
    if not status.allowed:
        raise RateLimitedError("Too many cart changes. Wait a moment.", headers=status.headers())


Mutation = Depends(limit_mutations)


def _respond(result: CartResult, response: Response, settings: Settings) -> CartView:
    if result.new_guest_token:
        set_cart_cookie(response, result.new_guest_token, settings)
    if result.clear_guest_cookie:
        clear_cart_cookie(response, settings)
    response.headers["Cache-Control"] = "no-store"
    return result.view


@router.get("", response_model=CartView, summary="The cart, priced and validated")
async def get_cart(
    owner: CartOwnerDep,
    service: CartServiceDep,
    where: EstimateDep,
    response: Response,
    settings: SettingsDep,
) -> CartView:
    return _respond(await service.get(owner, where), response, settings)


@router.post("/items", response_model=CartView, summary="Add an item", dependencies=[Mutation])
async def add_item(
    body: AddItem,
    owner: CartOwnerDep,
    service: CartServiceDep,
    where: EstimateDep,
    response: Response,
    settings: SettingsDep,
) -> CartView:
    result = await service.add(owner, body.variant_id, body.quantity, where)
    return _respond(result, response, settings)


@router.patch(
    "/items/{item_id}",
    response_model=CartView,
    summary="Change a quantity",
    dependencies=[Mutation],
)
async def set_quantity(
    item_id: uuid.UUID,
    body: SetQuantity,
    owner: CartOwnerDep,
    service: CartServiceDep,
    where: EstimateDep,
    response: Response,
    settings: SettingsDep,
) -> CartView:
    result = await service.set_quantity(owner, item_id, body.quantity, where)
    return _respond(result, response, settings)


@router.delete(
    "/items/{item_id}", response_model=CartView, summary="Remove an item", dependencies=[Mutation]
)
async def remove_item(
    item_id: uuid.UUID,
    owner: CartOwnerDep,
    service: CartServiceDep,
    where: EstimateDep,
    response: Response,
    settings: SettingsDep,
) -> CartView:
    return _respond(await service.remove(owner, item_id, where), response, settings)


@router.delete("", response_model=CartView, summary="Empty the cart", dependencies=[Mutation])
async def clear_cart(
    owner: CartOwnerDep,
    service: CartServiceDep,
    where: EstimateDep,
    response: Response,
    settings: SettingsDep,
) -> CartView:
    return _respond(await service.clear(owner, where), response, settings)


@router.post(
    "/discount", response_model=CartView, summary="Apply a discount code", dependencies=[Mutation]
)
async def apply_code(
    body: ApplyCode,
    owner: CartOwnerDep,
    service: CartServiceDep,
    where: EstimateDep,
    client: ClientDep,
    limiter: Limiter,
    response: Response,
    settings: SettingsDep,
) -> CartView:
    status = await limiter.hit(rate_limit.DISCOUNT_CODE_PER_IP, client.ip)
    if not status.allowed:
        raise RateLimitedError("Too many codes tried. Try again later.", headers=status.headers())
    return _respond(await service.apply_code(owner, body.code, where), response, settings)


@router.delete(
    "/discount", response_model=CartView, summary="Remove the code", dependencies=[Mutation]
)
async def remove_code(
    owner: CartOwnerDep,
    service: CartServiceDep,
    where: EstimateDep,
    response: Response,
    settings: SettingsDep,
) -> CartView:
    return _respond(await service.remove_code(owner, where), response, settings)


@router.post(
    "/merge",
    response_model=CartView,
    summary="Merge this browser's guest cart into the signed-in user's (also done at sign-in)",
)
async def merge(
    request: Request,
    principal: PrincipalDep,
    service: CartServiceDep,
    where: EstimateDep,
    response: Response,
    settings: SettingsDep,
) -> CartView:
    result = await service.merge(request.cookies.get(CART_COOKIE), principal.user_id, where)
    return _respond(result, response, settings)
