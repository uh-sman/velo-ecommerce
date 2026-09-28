"""Inventory errors. Services raise these; the global handler renders them."""

from __future__ import annotations

from velo.core.errors import ConflictError, ValidationError


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
