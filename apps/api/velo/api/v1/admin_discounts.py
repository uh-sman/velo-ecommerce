"""/admin/discounts — the discount builder, with a tester that prices a sample basket."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Query, status
from pydantic import BaseModel, ConfigDict, EmailStr, Field, StrictInt, StringConstraints

from velo.api.deps import DiscountAdminDep, DiscountsWriterDep
from velo.domains.discounts.admin import SampleLine
from velo.domains.discounts.models import Discount

router = APIRouter(prefix="/admin/discounts", tags=["admin: discounts"])

DiscountType = Literal["percentage", "fixed_amount", "free_shipping", "buy_x_get_y"]
Status = Literal["active", "scheduled", "expired", "used_up", "inactive"]
Code = Annotated[
    str, StringConstraints(strip_whitespace=True, to_upper=True, pattern=r"^[A-Za-z0-9_-]{3,32}$")
]


class DiscountFields(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: Code | None = Field(default=None, description="Empty: an automatic discount.")
    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
    type: DiscountType
    value: Annotated[Decimal, Field(ge=0, max_digits=10, decimal_places=4)] = Decimal(0)
    currency: Annotated[str, StringConstraints(pattern=r"^[A-Z]{3}$")] | None = None
    min_subtotal_amount: Annotated[StrictInt, Field(ge=0)] | None = None
    applies_to: Literal["all", "products", "collections"] = "all"
    target_ids: list[uuid.UUID] | None = None
    first_order_only: bool = False
    max_redemptions: Annotated[StrictInt, Field(ge=1)] | None = None
    max_per_customer: Annotated[StrictInt, Field(ge=1)] | None = None
    is_stackable: bool = False
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    is_active: bool = True
    buy_quantity: Annotated[StrictInt, Field(ge=1)] | None = None
    get_quantity: Annotated[StrictInt, Field(ge=1)] | None = None
    customer_segment: Literal["all", "returning", "subscribers", "staff"] = "all"


class DiscountPatch(BaseModel):
    """Only the fields sent change."""

    model_config = ConfigDict(extra="forbid")

    code: Code | None = None
    title: (
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
        | None
    ) = None
    type: DiscountType | None = None
    value: Annotated[Decimal, Field(ge=0, max_digits=10, decimal_places=4)] | None = None
    currency: Annotated[str, StringConstraints(pattern=r"^[A-Z]{3}$")] | None = None
    min_subtotal_amount: Annotated[StrictInt, Field(ge=0)] | None = None
    applies_to: Literal["all", "products", "collections"] | None = None
    target_ids: list[uuid.UUID] | None = None
    first_order_only: bool | None = None
    max_redemptions: Annotated[StrictInt, Field(ge=1)] | None = None
    max_per_customer: Annotated[StrictInt, Field(ge=1)] | None = None
    is_stackable: bool | None = None
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    is_active: bool | None = None
    buy_quantity: Annotated[StrictInt, Field(ge=1)] | None = None
    get_quantity: Annotated[StrictInt, Field(ge=1)] | None = None
    customer_segment: Literal["all", "returning", "subscribers", "staff"] | None = None


class DiscountView(BaseModel):
    id: uuid.UUID
    code: str | None
    title: str
    type: str
    value: Decimal
    currency: str | None
    min_subtotal_amount: int | None
    applies_to: str
    target_ids: list[uuid.UUID]
    first_order_only: bool
    max_redemptions: int | None
    max_per_customer: int | None
    times_redeemed: int
    is_stackable: bool
    starts_at: datetime
    ends_at: datetime | None
    is_active: bool
    buy_quantity: int | None
    get_quantity: int | None
    customer_segment: str
    status: Status
    created_at: datetime

    @classmethod
    def of(cls, row: Discount, state: str) -> DiscountView:
        return cls(
            id=row.id,
            code=row.code,
            title=row.title,
            type=row.type,
            value=row.value,
            currency=row.currency,
            min_subtotal_amount=row.min_subtotal_amount,
            applies_to=row.applies_to,
            target_ids=list(row.target_ids or []),
            first_order_only=row.first_order_only,
            max_redemptions=row.max_redemptions,
            max_per_customer=row.max_per_customer,
            times_redeemed=row.times_redeemed,
            is_stackable=row.is_stackable,
            starts_at=row.starts_at,
            ends_at=row.ends_at,
            is_active=row.is_active,
            buy_quantity=row.buy_quantity,
            get_quantity=row.get_quantity,
            customer_segment=row.customer_segment,
            status=state,
            created_at=row.created_at,
        )


class SampleLineIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    variant_id: uuid.UUID
    quantity: Annotated[StrictInt, Field(ge=1, le=999)] = 1


class PreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    discount: DiscountFields
    lines: Annotated[list[SampleLineIn], Field(min_length=1, max_length=50)]
    customer_email: EmailStr | None = Field(
        default=None, description="Check the customer rules for this person. Empty: a new guest."
    )


class PreviewView(BaseModel):
    eligible: bool
    customer_problem: str | None
    cart_problem: str | None
    currency: str
    subtotal: int
    discount: int
    shipping_discounted: bool
    total: int
    lines: list[dict[str, object]]


class RetiredView(BaseModel):
    outcome: Literal["deleted", "deactivated"]


@router.get("", response_model=list[DiscountView], summary="Every discount, newest first")
async def list_discounts(
    _: DiscountsWriterDep,
    service: DiscountAdminDep,
    q: Annotated[str | None, Query(max_length=100, description="Code or title.")] = None,
    status_filter: Annotated[Status | None, Query(alias="status")] = None,
) -> list[DiscountView]:
    return [
        DiscountView.of(row, state)
        for row, state in await service.search(query=q, status=status_filter)
    ]


@router.post("", response_model=DiscountView, status_code=status.HTTP_201_CREATED, summary="Create")
async def create_discount(
    body: DiscountFields, actor: DiscountsWriterDep, service: DiscountAdminDep
) -> DiscountView:
    fields = body.model_dump(exclude_none=True)
    fields.setdefault("code", None)
    row = await service.create(fields, actor)
    _, state = await service.get(row.id)
    return DiscountView.of(row, state)


@router.post("/preview", response_model=PreviewView, summary="Test a discount on a sample basket")
async def preview_discount(
    body: PreviewRequest, _: DiscountsWriterDep, service: DiscountAdminDep
) -> PreviewView:
    result = await service.preview(
        body.discount.model_dump(exclude_none=True),
        [SampleLine(line.variant_id, line.quantity) for line in body.lines],
        customer_email=str(body.customer_email) if body.customer_email else None,
    )
    return PreviewView(
        eligible=result.eligible,
        customer_problem=result.customer_problem,
        cart_problem=result.cart_problem,
        currency=result.currency,
        subtotal=result.subtotal,
        discount=result.discount,
        shipping_discounted=result.shipping_discounted,
        total=result.total,
        lines=result.lines,
    )


@router.get("/{discount_id}", response_model=DiscountView, summary="One discount")
async def get_discount(
    discount_id: uuid.UUID, _: DiscountsWriterDep, service: DiscountAdminDep
) -> DiscountView:
    row, state = await service.get(discount_id)
    return DiscountView.of(row, state)


@router.patch("/{discount_id}", response_model=DiscountView, summary="Edit")
async def update_discount(
    discount_id: uuid.UUID,
    body: DiscountPatch,
    actor: DiscountsWriterDep,
    service: DiscountAdminDep,
) -> DiscountView:
    row = await service.update(discount_id, body.model_dump(exclude_unset=True), actor)
    _, state = await service.get(row.id)
    return DiscountView.of(row, state)


@router.delete(
    "/{discount_id}",
    response_model=RetiredView,
    summary="Delete if never used; otherwise deactivate",
)
async def retire_discount(
    discount_id: uuid.UUID, actor: DiscountsWriterDep, service: DiscountAdminDep
) -> RetiredView:
    return RetiredView(outcome=await service.retire(discount_id, actor))
