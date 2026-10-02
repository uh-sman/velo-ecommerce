"""/admin/orders, /admin/fulfilments, /admin/returns — running orders without the database.

Permissions (identity/permissions.py): reading needs ``orders:read``;
shipping, statuses, notes and the return queue need ``orders:fulfil``;
anything that moves money — refunds, cancellation (which refunds), and
refunding a return — needs ``orders:refund``. Every mutation is written to
``audit_log`` and to the order's own ``order_events`` trail.

``POST /admin/orders/{id}/refunds`` requires ``Idempotency-Key``: a double
click or a retried request refunds once.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Query, Request, Response
from fastapi.responses import JSONResponse

from velo.api.deps import (
    FulfilmentServiceDep,
    IdempotencyDep,
    OrderLifecycleDep,
    OrderReaderDep,
    OrdersFulfilDep,
    OrdersReaderDep,
    OrdersRefundDep,
    PrincipalDep,
    RefundServiceDep,
    ReturnServiceDep,
    SettingsDep,
)
from velo.api.idempotency import run_idempotent, stored_response
from velo.api.openapi import PDF
from velo.core.errors import ForbiddenError, ValidationError
from velo.core.pagination import CursorPage, PaginationInfo, decode_cursor, encode_cursor
from velo.domains.identity.permissions import Permission, has_permission
from velo.domains.orders.documents import invoice_pdf, packing_slip_pdf
from velo.domains.orders.fulfilment import ShipLine
from velo.domains.orders.queries import admin_refund_view, return_view, shipment_view
from velo.domains.orders.refunds import RefundLine, RefundRequest
from velo.domains.orders.repository import OrderFilters
from velo.domains.orders.returns import ReceivedLine
from velo.domains.orders.views import (
    AdminOrderSummaryView,
    AdminOrderView,
    AdminRefundView,
    CancelOrder,
    CreateFulfilment,
    CreateRefund,
    ReturnView,
    SetNote,
    SetStatus,
    ShipmentView,
    UpdateReturn,
    UpdateShipment,
)

router = APIRouter(prefix="/admin", tags=["admin: orders"])

OrderStatusFilter = Literal[
    "pending",
    "paid",
    "processing",
    "partially_fulfilled",
    "fulfilled",
    "delivered",
    "cancelled",
    "refunded",
    "partially_refunded",
]


def _pdf(content: bytes, filename: str) -> Response:
    return Response(
        content,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )


# ── Orders ────────────────────────────────────────────────────────────────────


@router.get(
    "/orders",
    response_model=CursorPage[AdminOrderSummaryView],
    summary="Orders, newest first, with filters and search",
)
async def list_orders(
    _: OrdersReaderDep,
    reader: OrderReaderDep,
    status: OrderStatusFilter | None = None,
    payment_status: Literal["paid", "partially_refunded", "refunded", "pending", "failed"]
    | None = None,
    fulfilment_status: Literal["unfulfilled", "partially_fulfilled", "fulfilled", "returned"]
    | None = None,
    q: Annotated[
        str | None, Query(max_length=200, description="Order number, customer email, or SKU.")
    ] = None,
    placed_from: datetime | None = None,
    placed_to: datetime | None = None,
    min_total: Annotated[int | None, Query(ge=0, description="Minor units, inclusive.")] = None,
    max_total: Annotated[int | None, Query(ge=0, description="Minor units, inclusive.")] = None,
    needs_attention: Annotated[
        bool | None, Query(description="Stock shortfalls and open disputes only (or none).")
    ] = None,
    sort: Literal["newest", "oldest"] = "newest",
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    cursor: str | None = None,
) -> CursorPage[AdminOrderSummaryView]:
    tag = f"admin-orders-{sort}"
    after = decode_cursor(cursor, tag) if cursor else None
    views, has_more, total, last = await reader.search(
        OrderFilters(
            status=status,
            payment_status=payment_status,
            fulfilment_status=fulfilment_status,
            query=q,
            placed_from=placed_from,
            placed_to=placed_to,
            min_total=min_total,
            max_total=max_total,
            needs_attention=needs_attention,
            oldest_first=sort == "oldest",
        ),
        limit=limit,
        after=after,
    )
    return CursorPage[AdminOrderSummaryView](
        data=views,
        pagination=PaginationInfo(
            next_cursor=encode_cursor(tag, last.placed_at, last.id) if has_more and last else None,
            has_more=has_more,
            limit=limit,
            total_count=total,
        ),
    )


@router.get("/orders/{order_id}", response_model=AdminOrderView, summary="Order detail")
async def get_order(
    order_id: uuid.UUID, _: OrdersReaderDep, reader: OrderReaderDep
) -> AdminOrderView:
    return await reader.admin_view(await reader.by_id(order_id))


@router.post(
    "/orders/{order_id}/status",
    response_model=AdminOrderView,
    summary="Set processing or delivered by hand",
)
async def set_status(
    order_id: uuid.UUID,
    body: SetStatus,
    actor: OrdersFulfilDep,
    lifecycle: OrderLifecycleDep,
    reader: OrderReaderDep,
) -> AdminOrderView:
    order = await lifecycle.set_status(order_id, body.status, actor, reason=body.reason)
    return await reader.admin_view(order)


@router.patch("/orders/{order_id}/notes", response_model=AdminOrderView, summary="Internal note")
async def set_note(
    order_id: uuid.UUID,
    body: SetNote,
    actor: OrdersFulfilDep,
    lifecycle: OrderLifecycleDep,
    reader: OrderReaderDep,
) -> AdminOrderView:
    order = await lifecycle.set_note(order_id, body.internal_note, actor)
    return await reader.admin_view(order)


@router.post(
    "/orders/{order_id}/cancel",
    response_model=AdminOrderView,
    summary="Cancel before shipping: restock and refund in full",
)
async def cancel(
    order_id: uuid.UUID,
    body: CancelOrder,
    actor: OrdersRefundDep,
    lifecycle: OrderLifecycleDep,
    reader: OrderReaderDep,
) -> AdminOrderView:
    order, refund_id = await lifecycle.cancel(
        order_id, actor, by_customer=False, reason=body.reason
    )
    if refund_id is not None:
        await lifecycle.submit_refund(refund_id)
    return await reader.admin_view(await reader.by_id(order.id))


@router.post(
    "/orders/{order_id}/refunds",
    response_model=AdminRefundView,
    status_code=201,
    summary="Refund lines, shipping, or a goodwill amount",
    responses={201: {"description": "Requires `Idempotency-Key`."}},
)
async def refund(
    order_id: uuid.UUID,
    body: CreateRefund,
    request: Request,
    actor: OrdersRefundDep,
    refunds: RefundServiceDep,
    idempotency: IdempotencyDep,
) -> JSONResponse:
    async def work() -> AdminRefundView:
        record = await refunds.issue_and_submit(
            order_id,
            RefundRequest(
                lines=[
                    RefundLine(line.order_item_id, line.quantity, line.restock)
                    for line in body.lines
                ],
                include_shipping=body.include_shipping,
                extra_amount=body.extra_amount,
                reason=body.reason,
                note=body.note,
            ),
            actor,
        )
        return admin_refund_view(record)

    stored = await run_idempotent(
        request, idempotency, user_id=actor.user_id, status_code=201, work=work
    )
    return stored_response(stored)


@router.get(
    "/orders/{order_id}/invoice", summary="Invoice (PDF)", response_class=Response, responses=PDF
)
async def invoice(
    order_id: uuid.UUID, _: OrdersReaderDep, reader: OrderReaderDep, settings: SettingsDep
) -> Response:
    order = await reader.by_id(order_id)
    content = invoice_pdf(
        order,
        await reader.items(order.id),
        store_name=settings.store_name,
        payment_label=await reader.payment_label(order),
    )
    return _pdf(content, f"invoice-{order.order_number}.pdf")


@router.get(
    "/orders/{order_id}/packing-slip", summary="Packing slip (PDF)", response_class=Response
)
async def packing_slip(
    order_id: uuid.UUID,
    _: OrdersReaderDep,
    reader: OrderReaderDep,
    settings: SettingsDep,
    fulfilment_id: uuid.UUID | None = None,
) -> Response:
    order = await reader.by_id(order_id)
    parcel = await reader.fulfilment(fulfilment_id) if fulfilment_id else None
    if fulfilment_id and (parcel is None or parcel.order_id != order.id):
        raise ValidationError("That fulfilment is not part of this order.")
    content = packing_slip_pdf(
        order, await reader.items(order.id), store_name=settings.store_name, fulfilment=parcel
    )
    return _pdf(content, f"packing-slip-{order.order_number}.pdf")


# ── Fulfilment ────────────────────────────────────────────────────────────────


@router.post(
    "/orders/{order_id}/fulfilments",
    response_model=ShipmentView,
    status_code=201,
    summary="Ship some or all of an order",
)
async def fulfil(
    order_id: uuid.UUID,
    body: CreateFulfilment,
    actor: OrdersFulfilDep,
    fulfilment: FulfilmentServiceDep,
) -> ShipmentView:
    parcel = await fulfilment.fulfil(
        order_id,
        [ShipLine(line.order_item_id, line.quantity) for line in body.lines]
        if body.lines is not None
        else None,
        actor,
        carrier=body.carrier,
        tracking_number=body.tracking_number,
        tracking=body.tracking_url,
        notify=body.notify_customer,
    )
    return shipment_view(parcel)


@router.patch(
    "/fulfilments/{fulfilment_id}",
    response_model=ShipmentView,
    summary="Update a parcel: tracking, delivered, failed",
)
async def update_fulfilment(
    fulfilment_id: uuid.UUID,
    body: UpdateShipment,
    actor: OrdersFulfilDep,
    fulfilment: FulfilmentServiceDep,
    reader: OrderReaderDep,
) -> ShipmentView:
    current = await reader.fulfilment(fulfilment_id)
    parcel = await fulfilment.update_shipment(
        fulfilment_id,
        body.status or (current.status if current else "in_transit"),
        actor=actor,
        tracking_number=body.tracking_number,
        carrier=body.carrier,
    )
    return shipment_view(parcel)


# ── Returns ───────────────────────────────────────────────────────────────────


@router.get("/returns", response_model=CursorPage[ReturnView], summary="The returns queue")
async def list_returns(
    _: OrdersReaderDep,
    reader: OrderReaderDep,
    status: Literal[
        "requested", "approved", "rejected", "in_transit", "received", "refunded", "closed"
    ]
    | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    cursor: str | None = None,
) -> CursorPage[ReturnView]:
    after = decode_cursor(cursor, "returns") if cursor else None
    views, has_more, last, total = await reader.list_returns(
        status=status, limit=limit, after=after
    )
    return CursorPage[ReturnView](
        data=views,
        pagination=PaginationInfo(
            next_cursor=encode_cursor("returns", last.created_at, last.id)
            if has_more and last
            else None,
            has_more=has_more,
            limit=limit,
            total_count=total,
        ),
    )


@router.get("/returns/{return_id}", response_model=ReturnView, summary="One return")
async def get_return(
    return_id: uuid.UUID, _: OrdersReaderDep, reader: OrderReaderDep
) -> ReturnView:
    returned = await reader.get_return(return_id)
    order = await reader.by_id(returned.order_id)
    return return_view(returned, order.currency, order.order_number)


@router.patch(
    "/returns/{return_id}",
    response_model=ReturnView,
    summary="Approve, reject, receive, refund or close a return",
)
async def update_return(
    return_id: uuid.UUID,
    body: UpdateReturn,
    actor: OrdersFulfilDep,
    principal: PrincipalDep,
    returns: ReturnServiceDep,
    reader: OrderReaderDep,
) -> ReturnView:
    match body.action:
        case "approve" | "reject":
            updated = await returns.decide(
                return_id, body.action == "approve", body.staff_note, actor
            )
        case "mark_in_transit":
            updated = await returns.mark_in_transit(return_id, actor)
        case "receive":
            if not body.lines:
                raise ValidationError("Receiving a return needs a decision for every line.")
            updated = await returns.receive(
                return_id,
                [
                    ReceivedLine(line.order_item_id, line.condition, line.restock)
                    for line in body.lines
                ],
                actor,
                body.staff_note,
            )
        case "refund":
            if not has_permission(principal.role, Permission.ORDERS_REFUND):
                raise ForbiddenError("Refunding needs the orders:refund permission.")
            updated, refund_id = await returns.refund(
                return_id, actor, include_shipping=body.include_shipping, note=body.staff_note
            )
            await returns.submit_refund(refund_id)
        case "close":
            updated = await returns.close(return_id, actor)
    order = await reader.by_id(updated.order_id)
    return return_view(await reader.get_return(updated.id), order.currency, order.order_number)
