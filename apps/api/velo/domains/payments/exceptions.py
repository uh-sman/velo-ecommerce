"""Payment errors. Services raise these; the global handler renders them."""

from __future__ import annotations

from velo.core.errors import (
    ConflictError,
    DependencyUnavailableError,
    DomainError,
    ValidationError,
)


class PaymentsUnavailableError(DependencyUnavailableError):
    """The provider is down or not configured. The reservation is kept (§10)."""

    slug = "payments-unavailable"
    title = "Payments are temporarily unavailable"


class WebhookSignatureError(DomainError):
    """400 — nothing is read, stored, or acted on (PAYMENTS-AND-CHECKOUT.md §6.1)."""

    slug = "invalid-signature"
    title = "Invalid signature"


class IdempotencyKeyRequiredError(DomainError):
    """400 — a money-moving POST without ``Idempotency-Key`` (API-SPEC.md §1)."""

    slug = "idempotency-key-required"
    title = "Idempotency-Key header required"


class IdempotencyKeyReusedError(ValidationError):
    """422 — the same key with a different request: a client bug, never a replay."""

    slug = "idempotency-key-reused"
    title = "Idempotency key reused with a different request"


class RequestInProgressError(ConflictError):
    """409 — a request with this key is still running. Retry shortly."""

    slug = "request-in-progress"
    title = "A request with this key is in progress"

    def __init__(self) -> None:
        super().__init__(
            "The same request is still being processed. Retry in a moment.",
            headers={"Retry-After": "1"},
        )
