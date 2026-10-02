"""/orders — the customer's orders (API-SPEC.md §2, "Orders").

A signed-in customer reaches their own orders. A guest reaches one order by
its signed link (``?token=``, from the confirmation email and page) or by
``POST /orders/lookup`` with the order number and the email it was placed
with. Anything else is 404 — never 403, which would confirm the order exists.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response

from velo.api.deps import (
    ClientDep,
    OptionalPrincipalDep,
    OrderLifecycleDep,
    OrderReaderDep,
    PrincipalDep,
    ReturnServiceDep,
    SettingsDep,
    get_rate_limiter,
)
from velo.api.openapi import PDF
from velo.core import rate_limit
from velo.core.errors import NotFoundError, RateLimitedError
from velo.core.pagination import CursorPage, PaginationInfo, decode_cursor, encode_cursor
from velo.core.rate_limit import RateLimiter
from velo.domains.orders.documents import invoice_pdf, return_label_pdf
from velo.domains.orders.queries import return_view
from velo.domains.orders.returns import ReturnLine
from velo.domains.orders.views import (
    CancelOrder,
    GuestLookup,
    OrderSummaryView,
    OrderView,
    RequestReturn,
    ReturnView,
)
from velo.domains.platform.events import Actor

router = APIRouter(prefix="/orders", tags=["orders"])

Limiter = Annotated[RateLimiter, Depends(get_rate_limiter)]
Token = Annotated[str | None, Query(max_length=64, description="The signed link's token.")]
# A label can be printed once the return is approved, until it is closed.
_LABELLED = {"approved", "in_transit", "received", "refunded"}


def _private(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


def _pdf(content: bytes, filename: str) -> Response:
    return Response(
        content,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="{filename}"',
            "Cache-Control": "private, no-store",
        },
    )


@router.get("", response_model=CursorPage[OrderSummaryView], summary="Your orders, newest first")
async def list_orders(
    principal: PrincipalDep,
    reader: OrderReaderDep,
    response: Response,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
    cursor: str | None = None,
) -> CursorPage[OrderSummaryView]:
    _private(response)
    after = decode_cursor(cursor, "orders") if cursor else None
    views, has_more, last = await reader.list_for_user(principal.user_id, limit=limit, after=after)
    return CursorPage[OrderSummaryView](
        data=views,
        pagination=PaginationInfo(
            next_cursor=encode_cursor("orders", last.placed_at, last.id)
            if has_more and last
            else None,
            has_more=has_more,
            limit=limit,
        ),
    )


@router.post(
    "/lookup",
    response_model=OrderView,
    summary="Find a guest order by its number and email",
    description="Returns the order with `access_token` for its signed link. 10 an hour per IP.",
)
async def lookup(
    body: GuestLookup,
    reader: OrderReaderDep,
    client: ClientDep,
    limiter: Limiter,
    response: Response,
) -> OrderView:
    status = await limiter.hit(rate_limit.ORDER_LOOKUP_PER_IP, client.ip)
    if not status.allowed:
        raise RateLimitedError("Too many lookups. Try again later.", headers=status.headers())
    _private(response)
    order = await reader.lookup(body.number, str(body.email))
    return await reader.view(order, with_token=True)


@router.get("/{number}", response_model=OrderView, summary="One order")
async def get_order(
    number: str,
    principal: OptionalPrincipalDep,
    reader: OrderReaderDep,
    response: Response,
    token: Token = None,
) -> OrderView:
    _private(response)
    order = await reader.for_customer(
        number, user_id=principal.user_id if principal else None, token=token
    )
    return await reader.view(order, with_token=True)


@router.post("/{number}/cancel", response_model=OrderView, summary="Cancel before it ships")
async def cancel_order(
    number: str,
    body: CancelOrder,
    principal: OptionalPrincipalDep,
    reader: OrderReaderDep,
    lifecycle: OrderLifecycleDep,
    response: Response,
    token: Token = None,
) -> OrderView:
    _private(response)
    user_id = principal.user_id if principal else None
    order = await reader.for_customer(number, user_id=user_id, token=token)
    _, refund_id = await lifecycle.cancel(
        order.id, Actor(user_id=user_id), by_customer=True, reason=body.reason
    )
    if refund_id is not None:
        await lifecycle.submit_refund(refund_id)
    return await reader.view(await reader.by_id(order.id), with_token=True)


@router.get("/{number}/invoice", summary="Invoice (PDF)", response_class=Response, responses=PDF)
async def invoice(
    number: str,
    principal: OptionalPrincipalDep,
    reader: OrderReaderDep,
    settings: SettingsDep,
    token: Token = None,
) -> Response:
    order = await reader.for_customer(
        number, user_id=principal.user_id if principal else None, token=token
    )
    items = await reader.items(order.id)
    content = invoice_pdf(
        order,
        items,
        store_name=settings.store_name,
        payment_label=await reader.payment_label(order),
    )
    return _pdf(content, f"invoice-{order.order_number}.pdf")


@router.post(
    "/{number}/returns",
    response_model=ReturnView,
    status_code=201,
    summary="Ask to return shipped items",
)
async def request_return(
    number: str,
    body: RequestReturn,
    principal: OptionalPrincipalDep,
    reader: OrderReaderDep,
    returns: ReturnServiceDep,
    token: Token = None,
) -> ReturnView:
    user_id = principal.user_id if principal else None
    order = await reader.for_customer(number, user_id=user_id, token=token)
    created = await returns.request(
        order.id,
        [ReturnLine(line.order_item_id, line.quantity) for line in body.items],
        body.reason,
        body.note,
        customer_id=user_id,
    )
    return return_view(created, order.currency, order.order_number)


@router.get(
    "/{number}/returns/{rma}/label",
    summary="Return label (PDF)",
    response_class=Response,
    responses=PDF,
)
async def return_label(
    number: str,
    rma: str,
    principal: OptionalPrincipalDep,
    reader: OrderReaderDep,
    settings: SettingsDep,
    token: Token = None,
) -> Response:
    order = await reader.for_customer(
        number, user_id=principal.user_id if principal else None, token=token
    )
    returned = next(
        (r for r in await reader.returns(order.id) if r.rma_number == rma.upper()), None
    )
    if returned is None or returned.status not in _LABELLED:
        raise NotFoundError("No return label for that.")
    content = return_label_pdf(
        order,
        await reader.items(order.id),
        returned,
        store_name=settings.store_name,
        return_address=settings.return_address,
    )
    return _pdf(content, f"return-{returned.rma_number}.pdf")
