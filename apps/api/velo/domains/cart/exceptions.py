"""Cart errors. Services raise these; the global handler renders them."""

from __future__ import annotations

from velo.core.errors import ConflictError, FieldError, ValidationError


class NotPurchasableError(ConflictError):
    slug = "not-purchasable"
    title = "That item cannot be bought"


class QuantityUnavailableError(ConflictError):
    """More than can be sold. The detail says how many can."""

    slug = "quantity-unavailable"
    title = "Not enough in stock"

    def __init__(self, available: int) -> None:
        detail = (
            "This is sold out."
            if available == 0
            else f"Only {available} available. Lower the quantity to continue."
        )
        super().__init__(
            detail,
            errors=[FieldError(field="quantity", code="max", message=f"At most {available}.")],
        )
        self.available = available


class CurrencyMismatchError(ValidationError):
    slug = "currency-mismatch"
    title = "That item is priced in another currency"


class DiscountCodeError(ValidationError):
    """A code that cannot be used; ``reason`` is a stable slug a client can branch on."""

    slug = "discount-code-invalid"
    title = "That code cannot be used"

    def __init__(self, message: str, reason: str) -> None:
        super().__init__(message, errors=[FieldError(field="code", code=reason, message=message)])
        self.reason = reason
