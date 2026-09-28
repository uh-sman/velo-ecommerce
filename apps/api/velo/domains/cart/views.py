"""The cart as the storefront receives it — API-SPEC.md §2, "Cart"."""

from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt

from velo.core.pagination import MoneyJson

WarningCode = Literal[
    "unavailable",  # the product was unpublished or deleted; the line is not charged
    "price_changed",  # the price differs from the one last shown
    "insufficient_stock",  # fewer are available than the line asks for
    "quantity_reduced",  # a merge was limited by stock
    "discount_not_applied",  # the applied code does not apply to this cart (yet)
    "discount_outclassed",  # a better discount applies instead of the code
    "no_shipping",  # nothing ships to the estimate address
]


class CartWarning(BaseModel):
    code: WarningCode
    message: str
    item_id: uuid.UUID | None = None
    previous_price: MoneyJson | None = None


class VariantRef(BaseModel):
    id: uuid.UUID
    sku: str
    product_title: str
    product_slug: str
    variant_title: str
    image_url: str | None


class ItemAvailability(BaseModel):
    in_stock: bool
    max_quantity: int  # the most that can be ordered now (999 when unlimited)


class CartItemView(BaseModel):
    id: uuid.UUID
    variant: VariantRef
    quantity: int
    unit_price: MoneyJson
    compare_at: MoneyJson | None
    line_total: MoneyJson  # unit price x quantity, before discounts
    line_discount: MoneyJson
    purchasable: bool
    availability: ItemAvailability


class AppliedDiscountView(BaseModel):
    code: str | None
    title: str
    type: str
    amount: MoneyJson


class ShippingOptionView(BaseModel):
    id: uuid.UUID
    name: str
    price: MoneyJson
    est_days_min: int | None
    est_days_max: int | None


class ShippingEstimate(BaseModel):
    options: list[ShippingOptionView]
    selected_id: uuid.UUID | None


class Totals(BaseModel):
    subtotal: MoneyJson
    discount: MoneyJson
    shipping: MoneyJson | None  # null until an address is known: zero is a claim
    tax: MoneyJson | None
    tax_included: MoneyJson | None  # inclusive tax (VAT) already in the prices
    total: MoneyJson


class CartView(BaseModel):
    id: uuid.UUID | None  # null before anything has been added
    currency: str
    items: list[CartItemView]
    discount: AppliedDiscountView | None  # the customer's code, when it applies
    discounts: list[AppliedDiscountView]  # every discount applied, automatic ones included
    discount_code: str | None  # the code the customer entered, whether or not it applies
    totals: Totals
    shipping: ShippingEstimate | None
    item_count: int
    warnings: list[CartWarning]


# ── Requests ──────────────────────────────────────────────────────────────────


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AddItem(RequestModel):
    """A variant and a quantity: the whole vocabulary a client has (API-SPEC.md §2)."""

    variant_id: uuid.UUID
    quantity: StrictInt = Field(default=1, ge=1, le=999)


class SetQuantity(RequestModel):
    quantity: StrictInt = Field(ge=0, le=999, description="0 removes the line.")


class ApplyCode(RequestModel):
    code: str = Field(min_length=1, max_length=64)
