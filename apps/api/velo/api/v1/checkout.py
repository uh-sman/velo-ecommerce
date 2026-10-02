"""/checkout — from the cart to a payment intent (API-SPEC.md §2, "Checkout").

``POST /checkout`` and ``POST /checkout/{id}/payment-intent`` move money and
require ``Idempotency-Key``. Creation sets the ``velo_checkout`` cookie that
proves this browser owns the session; a signed-in owner is recognised by
account as well. Anyone else gets 404.

Nothing here accepts a price or card data. The body of each step is an email,
an address, or a shipping rate id — the server computes every amount.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse

from velo.api.cookies import set_checkout_cookie
from velo.api.deps import (
    AuthServiceDep,
    CartOwnerDep,
    CheckoutAccessDep,
    CheckoutServiceDep,
    ClientDep,
    IdempotencyDep,
    OptionalPrincipalDep,
    SettingsDep,
    get_rate_limiter,
)
from velo.api.idempotency import run_idempotent, stored_response
from velo.core import rate_limit
from velo.core.errors import FieldError, RateLimitedError, ValidationError
from velo.core.rate_limit import RateLimiter
from velo.domains.checkout.views import (
    CheckoutView,
    PaymentIntentView,
    SetAddress,
    SetShipping,
    ShippingRatesView,
    StartCheckout,
)

router = APIRouter(prefix="/checkout", tags=["checkout"])

Limiter = Annotated[RateLimiter, Depends(get_rate_limiter)]
_IDEMPOTENT = {
    "description": "Requires `Idempotency-Key`. A replay returns the stored response "
    "with `Idempotency-Replayed: true`."
}


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"


@router.post(
    "",
    status_code=201,
    response_model=CheckoutView,
    summary="Start checkout: snapshot the priced cart and reserve its stock",
    responses={201: _IDEMPOTENT},
)
async def start_checkout(
    body: StartCheckout,
    request: Request,
    owner: CartOwnerDep,
    principal: OptionalPrincipalDep,
    auth: AuthServiceDep,
    service: CheckoutServiceDep,
    idempotency: IdempotencyDep,
    client: ClientDep,
    limiter: Limiter,
    settings: SettingsDep,
) -> JSONResponse:
    status = await limiter.hit(rate_limit.CHECKOUT_PER_IP, client.ip)
    if not status.allowed:
        raise RateLimitedError(
            "Too many checkouts started. Try again later.", headers=status.headers()
        )
    if principal is not None:
        email = (await auth.get_user(principal.user_id)).email
    elif body.email:
        email = str(body.email)
    else:
        raise ValidationError(
            "An email address is needed for the order confirmation.",
            errors=[FieldError(field="email", code="missing", message="Enter your email.")],
        )

    async def create() -> CheckoutView:
        return await service.create(owner, email)

    stored = await run_idempotent(
        request,
        idempotency,
        user_id=principal.user_id if principal else None,
        status_code=201,
        work=create,
    )
    response = stored_response(stored)
    # Also on a replay: the token is derived, not stored, so it can be set again.
    set_checkout_cookie(response, service.token_for(uuid.UUID(stored.body["id"])), settings)
    return response


@router.get("/{checkout_id}", response_model=CheckoutView, summary="State and totals")
async def get_checkout(
    checkout_id: uuid.UUID,
    access: CheckoutAccessDep,
    service: CheckoutServiceDep,
    response: Response,
) -> CheckoutView:
    _no_store(response)
    return await service.get(checkout_id, access)


@router.patch(
    "/{checkout_id}/address",
    response_model=CheckoutView,
    summary="Set the shipping and billing addresses",
)
async def set_address(
    checkout_id: uuid.UUID,
    body: SetAddress,
    access: CheckoutAccessDep,
    service: CheckoutServiceDep,
    response: Response,
) -> CheckoutView:
    _no_store(response)
    return await service.set_address(
        checkout_id,
        access,
        body.shipping_address.model_dump(),
        body.billing_address.model_dump() if body.billing_address else None,
    )


@router.get(
    "/{checkout_id}/shipping-rates",
    response_model=ShippingRatesView,
    summary="The rates available for the address",
)
async def shipping_rates(
    checkout_id: uuid.UUID,
    access: CheckoutAccessDep,
    service: CheckoutServiceDep,
    response: Response,
) -> ShippingRatesView:
    _no_store(response)
    return await service.shipping_rates(checkout_id, access)


@router.patch(
    "/{checkout_id}/shipping", response_model=CheckoutView, summary="Choose a shipping rate"
)
async def set_shipping(
    checkout_id: uuid.UUID,
    body: SetShipping,
    access: CheckoutAccessDep,
    service: CheckoutServiceDep,
    response: Response,
) -> CheckoutView:
    _no_store(response)
    return await service.set_shipping(checkout_id, access, body.shipping_rate_id)


@router.post(
    "/{checkout_id}/payment-intent",
    status_code=201,
    response_model=PaymentIntentView,
    summary="Recompute the total and create the provider's payment intent",
    responses={201: _IDEMPOTENT},
)
async def payment_intent(
    checkout_id: uuid.UUID,
    request: Request,
    access: CheckoutAccessDep,
    service: CheckoutServiceDep,
    idempotency: IdempotencyDep,
    limiter: Limiter,
) -> JSONResponse:
    status = await limiter.hit(rate_limit.PAYMENT_INTENT_PER_CHECKOUT, str(checkout_id))
    if not status.allowed:
        raise RateLimitedError(
            "Too many payment attempts. Try again later.", headers=status.headers()
        )

    async def start() -> PaymentIntentView:
        return await service.start_payment(checkout_id, access)

    stored = await run_idempotent(
        request, idempotency, user_id=access.user_id, status_code=201, work=start
    )
    return stored_response(stored)


@router.post(
    "/{checkout_id}/abandon",
    response_model=CheckoutView,
    summary="Cancel the checkout and release its stock",
)
async def abandon(
    checkout_id: uuid.UUID,
    access: CheckoutAccessDep,
    service: CheckoutServiceDep,
    response: Response,
) -> CheckoutView:
    _no_store(response)
    return await service.abandon(checkout_id, access)
