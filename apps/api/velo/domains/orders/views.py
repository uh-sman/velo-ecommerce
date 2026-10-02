"""Orders as the storefront and the admin see them — API-SPEC.md §2, "Orders".

Money is ``{"amount", "currency"}`` in minor units, like everywhere else.
Request models forbid unknown fields; no body can carry a price — a refund
names lines and units, and the server prices them from the order's snapshot.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    EmailStr,
    Field,
    StrictBool,
    StrictInt,
    StringConstraints,
)

from velo.core.pagination import MoneyJson

Note = Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)]
ShortText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ── Responses ────────────────────────────────────────────────────────────────


class OrderLineView(BaseModel):
    id: uuid.UUID
    variant_id: uuid.UUID | None
    product_title: str
    variant_title: str
    sku: str
    image_url: str | None
    quantity: int
    unit_price: MoneyJson
    discount: MoneyJson
    tax: MoneyJson
    total: MoneyJson
    quantity_fulfilled: int
    quantity_returned: int
    quantity_refunded: int
    returnable_quantity: int


class OrderTotalsView(BaseModel):
    subtotal: MoneyJson
    discount: MoneyJson
    shipping: MoneyJson
    tax: MoneyJson
    total: MoneyJson
    refunded: MoneyJson


class ShipmentView(BaseModel):
    id: uuid.UUID
    status: str
    carrier: str | None
    tracking_number: str | None
    tracking_url: str | None
    shipped_at: datetime | None
    delivered_at: datetime | None
    lines: list[dict[str, Any]]  # {"order_item_id", "quantity"}


class ReturnLineView(BaseModel):
    order_item_id: uuid.UUID
    quantity: int
    condition: str | None
    restock: bool
    product_title: str
    variant_title: str
    sku: str


class ReturnView(BaseModel):
    id: uuid.UUID
    rma_number: str
    status: str
    reason: str
    customer_note: str | None
    staff_note: str | None
    refund_amount: MoneyJson | None
    created_at: datetime
    lines: list[ReturnLineView]
    order_id: uuid.UUID
    order_number: str | None = None


class RefundView(BaseModel):
    id: uuid.UUID
    amount: MoneyJson
    status: str
    reason: str
    created_at: datetime
    return_id: uuid.UUID | None


class AdminRefundView(RefundView):
    note: str | None
    actor_id: uuid.UUID | None
    provider_refund_id: str | None
    attempts: int
    last_error: str | None
    lines: list[dict[str, Any]]


class PaymentSummaryView(BaseModel):
    provider: str
    method: str | None  # "card", "apple_pay", …
    card_brand: str | None
    card_last4: str | None
    captured: MoneyJson
    refunded: MoneyJson


class OrderSummaryView(BaseModel):
    number: str
    status: str
    payment_status: str
    fulfilment_status: str
    placed_at: datetime
    total: MoneyJson
    item_count: int


class OrderView(BaseModel):
    number: str
    status: str
    payment_status: str
    fulfilment_status: str
    placed_at: datetime
    cancelled_at: datetime | None
    email: str
    currency: str
    lines: list[OrderLineView]
    totals: OrderTotalsView
    discount_code: str | None
    shipping_address: dict[str, Any]
    billing_address: dict[str, Any]
    shipping_method: str | None
    shipments: list[ShipmentView]
    returns: list[ReturnView]
    refunds: list[RefundView]
    payment: PaymentSummaryView | None
    can_cancel: bool
    can_return: bool
    # A signed link that opens this order without signing in (PAGE-SPECS.md §1.4).
    access_token: str | None = None


class OrderEventView(BaseModel):
    id: uuid.UUID
    event_type: str
    from_status: str | None
    to_status: str | None
    actor_type: str
    actor_id: uuid.UUID | None
    payload: dict[str, Any]
    created_at: datetime
    actor_email: str | None = None


class AdminOrderSummaryView(OrderSummaryView):
    id: uuid.UUID
    email: str
    customer_name: str | None
    needs_attention: bool


class PaymentReferenceView(BaseModel):
    provider: str
    intent_id: str | None  # to find the payment in the provider's dashboard
    charge_id: str | None


class AdminOrderView(OrderView):
    id: uuid.UUID
    payment_reference: PaymentReferenceView | None
    user_id: uuid.UUID | None
    internal_note: str | None
    customer_note: str | None
    metadata: dict[str, Any]
    events: list[OrderEventView]
    admin_refunds: list[AdminRefundView]
    refundable: MoneyJson


# ── Requests ─────────────────────────────────────────────────────────────────


class GuestLookup(RequestModel):
    number: Annotated[str, StringConstraints(strip_whitespace=True, min_length=4, max_length=20)]
    email: EmailStr


class CancelOrder(RequestModel):
    reason: Note | None = None


class ReturnLineIn(RequestModel):
    order_item_id: uuid.UUID
    quantity: Annotated[StrictInt, Field(ge=1, le=999)]


class RequestReturn(RequestModel):
    items: Annotated[list[ReturnLineIn], Field(min_length=1, max_length=100)]
    reason: Literal[
        "changed_mind",
        "wrong_size",
        "not_as_described",
        "damaged",
        "defective",
        "wrong_item",
        "other",
    ]
    note: Note | None = None


class SetStatus(RequestModel):
    status: Literal["processing", "delivered"]
    reason: Note | None = None


class SetNote(RequestModel):
    internal_note: Note | None


class ShipLineIn(RequestModel):
    order_item_id: uuid.UUID
    quantity: Annotated[StrictInt, Field(ge=1, le=999)]


class CreateFulfilment(RequestModel):
    # Omitted: everything left to ship.
    lines: Annotated[list[ShipLineIn], Field(min_length=1, max_length=200)] | None = None
    carrier: ShortText | None = None
    tracking_number: ShortText | None = None
    tracking_url: Annotated[str, StringConstraints(max_length=500, pattern=r"^https://")] | None = (
        None
    )
    notify_customer: StrictBool = True


class UpdateShipment(RequestModel):
    status: Literal["in_transit", "delivered", "failed", "cancelled"] | None = None
    carrier: ShortText | None = None
    tracking_number: ShortText | None = None


class RefundLineIn(RequestModel):
    order_item_id: uuid.UUID
    quantity: Annotated[StrictInt, Field(ge=1, le=999)]
    restock: StrictBool = False


class CreateRefund(RequestModel):
    """Lines and units — never an amount for them. The server prices each unit."""

    lines: Annotated[list[RefundLineIn], Field(max_length=200)] = []
    include_shipping: StrictBool = False
    # Goodwill on top of any lines, in minor units.
    extra_amount: Annotated[StrictInt, Field(ge=0)] = 0
    reason: Literal["requested_by_customer", "duplicate", "fraudulent", "defective", "other"]
    note: Note | None = None


class ReceivedLineIn(RequestModel):
    order_item_id: uuid.UUID
    condition: Literal["new", "opened", "damaged"]
    restock: StrictBool


class UpdateReturn(RequestModel):
    action: Literal["approve", "reject", "mark_in_transit", "receive", "refund", "close"]
    staff_note: Note | None = None
    # For "receive": every line, with its condition and the restock decision.
    lines: list[ReceivedLineIn] | None = None
    # For "refund": also refund the shipping the customer paid.
    include_shipping: StrictBool = False


class TrackingUpdate(RequestModel):
    """A carrier (or an aggregator) reporting a parcel's progress."""

    model_config = ConfigDict(extra="ignore")  # carriers send more than we read

    tracking_number: ShortText
    status: Literal[
        "in_transit", "out_for_delivery", "delivered", "failed", "exception", "returned"
    ]
    occurred_at: datetime | None = None
