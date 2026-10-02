"""The payment provider interface — PAYMENTS-AND-CHECKOUT.md §4, ADR-006.

One protocol, several providers. Swapping Stripe for Paystack is a
configuration change (:mod:`velo.domains.payments.registry`), not a refactor.

Everything a provider returns is normalised here: statuses to
:class:`IntentStatus`, currencies to upper case, money to integer minor units,
webhooks to :class:`WebhookEvent`. Nothing above this module knows a provider's
vocabulary.

**Card data.** A provider hands back a brand and the last four digits, for
display. Nothing that could hold a card number exists in these types, and no
request body anywhere carries one (§9).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Protocol


class IntentStatus(StrEnum):
    REQUIRES_PAYMENT = "requires_payment"  # created, or a try failed: the customer may pay
    REQUIRES_ACTION = "requires_action"  # 3-D Secure or similar, inside the provider's UI
    PROCESSING = "processing"
    SUCCEEDED = "succeeded"
    FAILED = "failed"  # will not succeed; a new intent is needed
    CANCELLED = "cancelled"


class RefundReason(StrEnum):
    REQUESTED_BY_CUSTOMER = "requested_by_customer"
    DUPLICATE = "duplicate"
    FRAUDULENT = "fraudulent"
    DEFECTIVE = "defective"
    OTHER = "other"


@dataclass(frozen=True, slots=True)
class PaymentIntent:
    id: str
    status: IntentStatus
    amount: int
    currency: str
    amount_received: int = 0
    client_secret: str | None = None  # handed to the browser; never logged
    charge_id: str | None = None
    payment_method_type: str | None = None
    card_brand: str | None = None
    card_last4: str | None = None
    failure_code: str | None = None
    failure_message: str | None = None
    amount_refunded: int = 0
    metadata: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class RefundResult:
    id: str
    status: str  # pending | succeeded | failed | cancelled
    amount: int


class EventKind(StrEnum):
    PAYMENT_SUCCEEDED = "payment.succeeded"
    PAYMENT_FAILED = "payment.failed"
    PAYMENT_CANCELLED = "payment.cancelled"
    PAYMENT_PROCESSING = "payment.processing"
    PAYMENT_REQUIRES_ACTION = "payment.requires_action"
    CHARGE_REFUNDED = "charge.refunded"
    DISPUTE_CREATED = "dispute.created"
    DISPUTE_CLOSED = "dispute.closed"
    OTHER = "other"  # recorded, acknowledged, and not acted on


@dataclass(frozen=True, slots=True)
class RefundInfo:
    id: str
    amount: int
    status: str


@dataclass(frozen=True, slots=True)
class DisputeInfo:
    id: str
    amount: int
    reason: str | None
    status: str | None


@dataclass(frozen=True, slots=True)
class WebhookEvent:
    """A verified provider event, in our vocabulary."""

    id: str  # the provider's event id: the deduplication key
    type: str  # the provider's own name for it
    kind: EventKind
    intent_id: str | None
    payload: dict[str, Any]  # the whole event, as received — stored before acting on it
    payment_ref: str | None = None  # our payment id, from the intent's metadata
    intent: PaymentIntent | None = None  # the intent as the event describes it
    amount_refunded: int | None = None  # cumulative, when the provider reports it
    refund: RefundInfo | None = None
    dispute: DisputeInfo | None = None


class SignatureError(Exception):
    """The webhook's signature does not match its body, or is missing or stale."""


class ProviderError(Exception):
    """The provider refused a call, or could not be reached.

    ``retryable``: a timeout, a 5xx, a rate limit — worth trying again. Otherwise
    the request itself was wrong (a 4xx), and repeating it will not help.
    """

    def __init__(self, message: str, *, retryable: bool, code: str | None = None) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.code = code


class PaymentProvider(Protocol):
    name: str
    publishable_key: str

    async def create_intent(
        self,
        *,
        amount: int,  # minor units — never from a request body
        currency: str,
        idempotency_key: str,
        metadata: dict[str, str],
        email: str,
    ) -> PaymentIntent: ...

    async def get_intent(self, intent_id: str) -> PaymentIntent: ...

    async def capture(self, intent_id: str, *, idempotency_key: str) -> PaymentIntent: ...

    async def cancel(self, intent_id: str, *, idempotency_key: str) -> PaymentIntent: ...

    async def refund(
        self, *, intent_id: str, amount: int, reason: RefundReason, idempotency_key: str
    ) -> RefundResult: ...

    def verify_webhook(self, raw_body: bytes, signature: str) -> WebhookEvent:
        """Check the signature over the exact bytes received, then parse.

        Raw bytes, never a parsed dict: re-serialising a dict produces
        different bytes, and the check fails — or worse, gets "fixed" by
        being skipped.
        """
        ...

    def parse_event(self, payload: dict[str, Any]) -> WebhookEvent:
        """Normalise an event already verified and stored, for (re)processing."""
        ...

    async def aclose(self) -> None: ...
