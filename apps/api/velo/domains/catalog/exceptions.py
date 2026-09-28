"""Catalog errors. Services raise these; the global handler renders them."""

from __future__ import annotations

from velo.core.errors import ConflictError, FieldError, ValidationError


class SlugTakenError(ConflictError):
    slug = "slug-taken"
    title = "That URL is already in use"

    def __init__(self, value: str, field: str = "slug") -> None:
        super().__init__(
            f"“{value}” is used by another item. Choose another.",
            errors=[FieldError(field=field, code="taken", message="Already in use.")],
        )


class SkuTakenError(ConflictError):
    slug = "sku-taken"
    title = "That SKU is already in use"

    def __init__(self, sku: str) -> None:
        super().__init__(
            f"SKU {sku} belongs to another variant.",
            errors=[FieldError(field="sku", code="taken", message="Already in use.")],
        )


class DuplicateVariantError(ConflictError):
    slug = "duplicate-variant"
    title = "That combination already exists"


class CatalogRuleError(ValidationError):
    """A request that is well-formed but breaks a catalog rule (a cycle, a missing option)."""

    slug = "catalog-rule"
    title = "That change is not allowed"


class NotPublishableError(ValidationError):
    slug = "not-publishable"
    title = "This product cannot be published yet"


class AlreadyReviewedError(ConflictError):
    slug = "already-reviewed"
    title = "You have already reviewed this product"


class InvalidMediaError(ValidationError):
    slug = "invalid-media"
    title = "That file cannot be used"
