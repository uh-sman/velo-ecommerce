"""Checkout as the storefront sends and receives it — API-SPEC.md §2, "Checkout".

Request models forbid unknown fields, and none has a field that could carry a
price or a card number (PAYMENTS-AND-CHECKOUT.md §1 and §9). An address, a
shipping choice, an email: that is all a client can say.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, StringConstraints

from velo.core.pagination import MoneyJson
from velo.domains.cart.views import AppliedDiscountView, CartWarning

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
Line = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Short = Annotated[str, StringConstraints(strip_whitespace=True, max_length=100)]
# Either case; the service upper-cases it (checkout/service.py, normalise_address).
Country = Annotated[str, StringConstraints(strip_whitespace=True, pattern=r"^[A-Za-z]{2}$")]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class StartCheckout(RequestModel):
    """A guest gives an email here; a signed-in customer's account email is used."""

    email: EmailStr | None = None


class AddressIn(RequestModel):
    first_name: Name
    last_name: Name
    company: Short | None = None
    line1: Line
    line2: Line | None = None
    city: Name
    region: Short | None = None
    postal_code: Annotated[str, StringConstraints(strip_whitespace=True, max_length=20)] | None = (
        None
    )
    country_code: Country
    phone: Annotated[str, StringConstraints(strip_whitespace=True, max_length=32)] | None = None


class SetAddress(RequestModel):
    shipping_address: AddressIn
    billing_address: AddressIn | None = None  # None: the same as shipping


class SetShipping(RequestModel):
    shipping_rate_id: uuid.UUID | None = None  # None only when nothing needs shipping


# ── Responses ────────────────────────────────────────────────────────────────


class AddressOut(BaseModel):
    first_name: str
    last_name: str
    company: str | None
    line1: str
    line2: str | None
    city: str
    region: str | None
    postal_code: str | None
    country_code: str
    phone: str | None


class CheckoutLineView(BaseModel):
    variant_id: uuid.UUID
    sku: str
    product_title: str
    variant_title: str
    image_url: str | None
    quantity: int
    unit_price: MoneyJson
    line_total: MoneyJson  # unit price x quantity
    line_discount: MoneyJson


class ShippingMethodView(BaseModel):
    id: uuid.UUID
    name: str
    price: MoneyJson
    est_days_min: int | None
    est_days_max: int | None


class CheckoutTotals(BaseModel):
    subtotal: MoneyJson
    discount: MoneyJson
    shipping: MoneyJson | None  # None until an address is known
    tax: MoneyJson | None
    tax_included: MoneyJson | None  # VAT already inside the prices, when there is any
    total: MoneyJson


class PaymentStateView(BaseModel):
    status: str  # pending | requires_action | processing | succeeded | failed | cancelled
    failure_message: str | None


class CheckoutView(BaseModel):
    id: uuid.UUID
    status: Literal[
        "initiated",
        "address_set",
        "shipping_set",
        "payment_pending",
        "confirmed",
        "failed",
        "expired",
        "abandoned",
    ]
    email: str
    currency: str
    items: list[CheckoutLineView]
    discounts: list[AppliedDiscountView]
    totals: CheckoutTotals
    shipping_address: AddressOut | None
    billing_address: AddressOut | None
    shipping_method: ShippingMethodView | None
    expires_at: datetime
    warnings: list[CartWarning]
    payment: PaymentStateView | None
    # Set once the order exists. The confirmation page polls until it is.
    order_number: str | None


class ShippingRatesView(BaseModel):
    options: list[ShippingMethodView]
    selected_id: uuid.UUID | None


class PaymentIntentView(BaseModel):
    payment_id: uuid.UUID
    provider: str
    client_secret: str
    publishable_key: str
    amount: MoneyJson  # the server's figure, for display — never confirmed by the client
    expires_at: datetime
