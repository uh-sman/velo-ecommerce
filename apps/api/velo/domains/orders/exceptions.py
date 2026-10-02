"""Order errors — each with a stable slug the storefront and admin branch on."""

from __future__ import annotations

from velo.core.errors import ConflictError, DependencyUnavailableError, ValidationError


class NotCancellableError(ConflictError):
    """409 — it has shipped, or is already cancelled or refunded."""

    slug = "not-cancellable"
    title = "This order can no longer be cancelled"


class RefundExceedsCaptureError(ValidationError):
    """422 — cumulative refunds would pass what was captured (PAYMENTS-AND-CHECKOUT.md §8)."""

    slug = "refund-exceeds-capture"
    title = "That refund is more than what is left to refund"


class NothingToRefundError(ValidationError):
    slug = "nothing-to-refund"
    title = "Nothing to refund"


class QuantityExceededError(ValidationError):
    """422 — more units than the line has left to fulfil, return, or refund."""

    slug = "quantity-exceeded"
    title = "More than the order line allows"


class FulfilmentBlockedError(ConflictError):
    """409 — unpaid, cancelled, or under an open chargeback."""

    slug = "fulfilment-blocked"
    title = "This order cannot be fulfilled"


class ReturnNotAllowedError(ConflictError):
    slug = "return-not-allowed"
    title = "This order cannot be returned"


class RefundProviderError(DependencyUnavailableError):
    """503 — the provider did not take the refund. It is recorded and will be retried."""

    slug = "refund-pending"
    title = "The refund is recorded and will be retried"
