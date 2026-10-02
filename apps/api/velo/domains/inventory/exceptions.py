"""Inventory errors. Services raise these; the global handler renders them."""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from velo.core.errors import ConflictError, FieldError, ValidationError


class InsufficientStockError(ConflictError):
    """An adjustment would leave less on hand than checkouts have reserved, or below zero."""

    slug = "insufficient-stock"
    title = "Not enough stock"


class InvalidAdjustmentError(ValidationError):
    slug = "invalid-adjustment"
    title = "That adjustment is not allowed"


class AlreadyInStockError(ConflictError):
    """Back-in-stock requests are for sold-out variants only."""

    slug = "already-in-stock"
    title = "This is in stock"


@dataclass(frozen=True, slots=True)
class Shortfall:
    """A variant a checkout wanted more of than could be sold."""

    variant_id: uuid.UUID
    requested: int
    available: int


class OutOfStockError(ConflictError):
    """Checkout could not reserve every line. One field error per short variant."""

    slug = "out-of-stock"
    title = "Out of stock"

    def __init__(self, shortfalls: list[Shortfall]) -> None:
        sold_out = all(item.available == 0 for item in shortfalls)
        super().__init__(
            "Sorry — the last one just sold."
            if sold_out and len(shortfalls) == 1
            else "Some items in your cart are no longer available in that quantity.",
            errors=[
                FieldError(
                    field=f"items.{item.variant_id}",
                    code="sold_out" if item.available == 0 else "max",
                    message="Sold out." if item.available == 0 else f"Only {item.available} left.",
                )
                for item in shortfalls
            ],
        )
        self.shortfalls = shortfalls
