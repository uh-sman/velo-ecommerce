"""Reading orders: the detail views, the lists, and who may see what.

A customer sees their own orders; a guest sees one order through its signed
link or the number-and-email lookup. Anyone else asking for an order gets 404,
not 403 — a 403 would confirm the order exists (API-SPEC.md §1).
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from velo.core.errors import NotFoundError
from velo.core.pagination import MoneyJson
from velo.domains.orders.lifecycle import cancellable
from velo.domains.orders.repository import (
    FulfilmentRecord,
    OrderFilters,
    OrderItemRecord,
    OrderRecord,
    OrderRepository,
    ReturnRecord,
)
from velo.domains.orders.returns import ReturnService
from velo.domains.orders.rules import order_token, refundable, verify_order_token
from velo.domains.orders.views import (
    AdminOrderSummaryView,
    AdminOrderView,
    AdminRefundView,
    OrderEventView,
    OrderLineView,
    OrderSummaryView,
    OrderTotalsView,
    OrderView,
    PaymentSummaryView,
    RefundView,
    ReturnLineView,
    ReturnView,
    ShipmentView,
)
from velo.domains.payments.registry import PaymentProviders
from velo.domains.payments.repository import PaymentRepository, RefundRecord


def _money(amount: int, currency: str) -> MoneyJson:
    return MoneyJson(amount=amount, currency=currency)


def shipment_view(parcel: FulfilmentRecord) -> ShipmentView:
    return ShipmentView(
        id=parcel.id,
        status=parcel.status,
        carrier=parcel.carrier,
        tracking_number=parcel.tracking_number,
        tracking_url=parcel.tracking_url,
        shipped_at=parcel.shipped_at,
        delivered_at=parcel.delivered_at,
        lines=[{"order_item_id": str(i), "quantity": q} for i, q in parcel.items],
    )


def return_view(returned: ReturnRecord, currency: str, number: str | None = None) -> ReturnView:
    return ReturnView(
        id=returned.id,
        rma_number=returned.rma_number,
        status=returned.status,
        reason=returned.reason,
        customer_note=returned.customer_note,
        staff_note=returned.staff_note,
        refund_amount=_money(returned.refund_amount, currency)
        if returned.refund_amount is not None
        else None,
        created_at=returned.created_at,
        lines=[
            ReturnLineView(
                order_item_id=item.order_item_id,
                quantity=item.quantity,
                condition=item.condition,
                restock=item.restock,
            )
            for item in returned.items
        ],
        order_number=number,
    )


def admin_refund_view(refund: RefundRecord) -> AdminRefundView:
    return AdminRefundView(
        id=refund.id,
        amount=_money(refund.amount, refund.currency),
        status=refund.status,
        reason=refund.reason,
        created_at=refund.created_at,
        return_id=refund.return_id,
        note=refund.note,
        actor_id=refund.actor_id,
        provider_refund_id=refund.provider_refund_id,
        attempts=refund.attempts,
        last_error=refund.last_error,
        lines=[
            {
                "order_item_id": str(item.order_item_id),
                "quantity": item.quantity,
                "amount": item.amount,
                "restock": item.restock,
            }
            for item in refund.items
        ],
    )


class OrderReader:
    def __init__(
        self,
        session: AsyncSession,
        providers: PaymentProviders,
        *,
        secret: str,
        return_window_days: int,
    ) -> None:
        self._orders = OrderRepository(session)
        self._payments = PaymentRepository(session)
        self._returns = ReturnService(session, providers, window_days=return_window_days)
        self._secret = secret

    # ── Access ────────────────────────────────────────────────────────────

    async def for_customer(
        self, number: str, *, user_id: uuid.UUID | None, token: str | None
    ) -> OrderRecord:
        order = await self._orders.by_number(number)
        if order is None:
            raise NotFoundError("No such order.")
        owns = user_id is not None and order.user_id == user_id
        if not owns and not verify_order_token(self._secret, order.id, token):
            raise NotFoundError("No such order.")
        return order

    async def lookup(self, number: str, email: str) -> OrderRecord:
        order = await self._orders.by_number(number)
        if order is None or order.email.lower() != email.strip().lower():
            raise NotFoundError("No order matches that number and email.")
        return order

    def token_for(self, order: OrderRecord) -> str:
        return order_token(self._secret, order.id)

    async def by_id(self, order_id: uuid.UUID) -> OrderRecord:
        order = await self._orders.get(order_id)
        if order is None:
            raise NotFoundError("No such order.")
        return order

    # ── Views ─────────────────────────────────────────────────────────────

    async def view(self, order: OrderRecord, *, with_token: bool = False) -> OrderView:
        return OrderView(**(await self._parts(order, with_token=with_token)))

    async def admin_view(self, order: OrderRecord) -> AdminOrderView:
        parts = await self._parts(order, with_token=True)
        refunds = await self._payments.refunds_for_order(order.id)
        payment = await self._payments.settled_payment_for_order(order.id)
        committed = sum(r.amount for r in refunds if r.status in ("pending", "succeeded"))
        return AdminOrderView(
            **parts,
            id=order.id,
            user_id=order.user_id,
            internal_note=order.internal_note,
            customer_note=order.customer_note,
            metadata=order.metadata,
            events=[
                OrderEventView(
                    id=event.id,
                    event_type=event.event_type,
                    from_status=event.from_status,
                    to_status=event.to_status,
                    actor_type=event.actor_type,
                    actor_id=event.actor_id,
                    payload=event.payload,
                    created_at=event.created_at,
                )
                for event in await self._orders.events(order.id)
            ],
            admin_refunds=[admin_refund_view(r) for r in refunds],
            refundable=_money(
                refundable(payment.amount_captured, committed) if payment else 0, order.currency
            ),
        )

    async def _parts(self, order: OrderRecord, *, with_token: bool) -> dict[str, object]:
        currency = order.currency
        items = await self._orders.items(order.id)
        refunded_units = await self._payments.refunded_units(order.id)
        returnable = await self._returns.returnable(order)
        window = await self._returns.window_open(order)
        refunds = await self._payments.refunds_for_order(order.id)
        payment = await self._payments.settled_payment_for_order(order.id)
        shipping_method = order.metadata.get("shipping_method")
        return {
            "number": order.order_number,
            "status": order.status,
            "payment_status": order.payment_status,
            "fulfilment_status": order.fulfilment_status,
            "placed_at": order.placed_at,
            "cancelled_at": order.cancelled_at,
            "email": order.email,
            "currency": currency,
            "lines": [
                OrderLineView(
                    id=item.id,
                    variant_id=item.variant_id,
                    product_title=item.product_title,
                    variant_title=item.variant_title,
                    sku=item.sku,
                    image_url=item.image_url,
                    quantity=item.quantity,
                    unit_price=_money(item.unit_price_amount, currency),
                    discount=_money(item.discount_amount, currency),
                    tax=_money(item.tax_amount, currency),
                    total=_money(item.total_amount, currency),
                    quantity_fulfilled=item.quantity_fulfilled,
                    quantity_returned=item.quantity_returned,
                    quantity_refunded=refunded_units.get(item.id, (0, 0))[0],
                    returnable_quantity=returnable.get(item.id, 0) if window else 0,
                )
                for item in items
            ],
            "totals": OrderTotalsView(
                subtotal=_money(order.subtotal_amount, currency),
                discount=_money(order.discount_amount, currency),
                shipping=_money(order.shipping_amount, currency),
                tax=_money(order.tax_amount, currency),
                total=_money(order.total_amount, currency),
                refunded=_money(order.refunded_amount, currency),
            ),
            "discount_code": order.discount_code,
            "shipping_address": order.shipping_address,
            "billing_address": order.billing_address,
            "shipping_method": shipping_method.get("name")
            if isinstance(shipping_method, dict)
            else None,
            "shipments": [shipment_view(p) for p in await self._orders.fulfilments(order.id)],
            "returns": [return_view(r, currency) for r in await self._orders.returns_for(order.id)],
            "refunds": [
                RefundView(
                    id=r.id,
                    amount=_money(r.amount, r.currency),
                    status=r.status,
                    reason=r.reason,
                    created_at=r.created_at,
                    return_id=r.return_id,
                )
                for r in refunds
                if r.status != "failed"
            ],
            "payment": PaymentSummaryView(
                provider=payment.provider,
                method=payment.payment_method_type,
                card_brand=payment.card_brand,
                card_last4=payment.card_last4,
                captured=_money(payment.amount_captured, payment.currency),
                refunded=_money(payment.amount_refunded, payment.currency),
            )
            if payment
            else None,
            "can_cancel": cancellable(order, by_customer=True),
            "can_return": window and any(returnable.values()),
            "access_token": self.token_for(order) if with_token else None,
        }

    # ── Lists ─────────────────────────────────────────────────────────────

    async def list_for_user(
        self, user_id: uuid.UUID, *, limit: int, after: tuple[datetime, uuid.UUID] | None
    ) -> tuple[list[OrderSummaryView], bool, OrderRecord | None]:
        orders, has_more, _ = await self._orders.search(
            OrderFilters(user_id=user_id), limit=limit, after=after
        )
        return [await self._summary(o) for o in orders], has_more, orders[-1] if orders else None

    async def search(
        self,
        filters: OrderFilters,
        *,
        limit: int,
        after: tuple[datetime, uuid.UUID] | None,
    ) -> tuple[list[AdminOrderSummaryView], bool, int | None, OrderRecord | None]:
        orders, has_more, total = await self._orders.search(
            filters, limit=limit, after=after, count=True
        )
        views = []
        for order in orders:
            summary = await self._summary(order)
            address = order.shipping_address
            name = " ".join(filter(None, [address.get("first_name"), address.get("last_name")]))
            views.append(
                AdminOrderSummaryView(
                    **summary.model_dump(),
                    id=order.id,
                    email=order.email,
                    customer_name=name or None,
                    needs_attention=bool(
                        order.metadata.get("attention")
                        or order.metadata.get("dispute", {}).get("open")
                    ),
                )
            )
        return views, has_more, total, orders[-1] if orders else None

    async def _summary(self, order: OrderRecord) -> OrderSummaryView:
        items = await self._orders.items(order.id)
        return OrderSummaryView(
            number=order.order_number,
            status=order.status,
            payment_status=order.payment_status,
            fulfilment_status=order.fulfilment_status,
            placed_at=order.placed_at,
            total=_money(order.total_amount, order.currency),
            item_count=sum(item.quantity for item in items),
        )

    # ── For documents ─────────────────────────────────────────────────────

    async def items(self, order_id: uuid.UUID) -> list[OrderItemRecord]:
        return await self._orders.items(order_id)

    async def returns(self, order_id: uuid.UUID) -> list[ReturnRecord]:
        return await self._orders.returns_for(order_id)

    async def fulfilment(self, fulfilment_id: uuid.UUID) -> FulfilmentRecord | None:
        return await self._orders.fulfilment(fulfilment_id)

    async def get_return(self, return_id: uuid.UUID) -> ReturnRecord:
        found = await self._orders.get_return(return_id)
        if found is None:
            raise NotFoundError("No such return.")
        return found

    async def list_returns(
        self, *, status: str | None, limit: int, after: tuple[datetime, uuid.UUID] | None
    ) -> tuple[list[ReturnView], bool, ReturnRecord | None]:
        found, has_more = await self._orders.list_returns(status=status, limit=limit, after=after)
        views = []
        for returned in found:
            order = await self._orders.get(returned.order_id)
            assert order is not None
            views.append(return_view(returned, order.currency, order.order_number))
        return views, has_more, found[-1] if found else None

    async def payment_label(self, order: OrderRecord) -> str | None:
        payment = await self._payments.settled_payment_for_order(order.id)
        if payment is None:
            return None
        if payment.card_brand and payment.card_last4:
            return f"{payment.card_brand.title()} ending {payment.card_last4}"
        return (payment.payment_method_type or payment.provider).replace("_", " ").title()
