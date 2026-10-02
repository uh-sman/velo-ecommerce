"""Checkout errors — the rows of PAYMENTS-AND-CHECKOUT.md §10 that the API owns.

Each has a stable slug a storefront branches on to show its designed state.
"""

from __future__ import annotations

from velo.core.errors import ConflictError, DomainError, FieldError, ValidationError


class CheckoutExpiredError(DomainError):
    """410 — "Your checkout timed out. Your cart is saved." Restart from the cart."""

    status_code = 410
    slug = "checkout-expired"
    title = "Checkout expired"


class CartEmptyError(ValidationError):
    slug = "cart-empty"
    title = "Nothing to check out"


class AddressUnserviceableError(ValidationError):
    """422 — "We don't ship to that region yet." Shown inline on the address step."""

    slug = "address-unserviceable"
    title = "We do not ship there"

    def __init__(self) -> None:
        super().__init__(
            "We don't ship to that region yet.",
            errors=[
                FieldError(
                    field="shipping_address.country_code",
                    code="unserviceable",
                    message="We don't ship to that region yet.",
                )
            ],
        )


class ShippingRateError(ValidationError):
    slug = "shipping-rate-unavailable"
    title = "That shipping method is not available"


class PriceChangedError(ConflictError):
    """409 — the authoritative total moved since the customer last saw it.

    The checkout has already been re-priced; the client re-reads it, shows the
    new total, and asks again. Nothing was charged.
    """

    slug = "price-changed"
    title = "The total has changed"


class DiscountExpiredError(ValidationError):
    """422 — "That code expired while you were checking out." Already removed."""

    slug = "discount-expired"
    title = "That code can no longer be used"
