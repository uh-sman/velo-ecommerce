"""The checkout state machine — PAYMENTS-AND-CHECKOUT.md §2. Pure; no I/O.

A table of allowed ``(from, to)`` pairs. Anything absent from it is an error,
raised as :class:`IllegalTransitionError` (409) — never tolerated.

Two edges go beyond the diagram in §2, and both are about money that has
already been taken:

- ``failed → confirmed``: a card declined, the customer retried inside the
  provider's element on the same intent, and it succeeded. Webhooks are not
  ordered (§6.3), so the ``succeeded`` event can arrive after ``failed``.
- ``expired → confirmed``, ``abandoned → confirmed``: the customer paid, and
  the payment and the session's end crossed — a webhook raced the sweeper, or
  a declined intent was retried and paid after a new checkout of the same cart
  retired this one. The payment is real; the order must exist.

``failed → abandoned`` lets a customer walk away from a declined payment, and
lets a new checkout of the same cart retire the old one.
"""

from __future__ import annotations

from enum import StrEnum

from velo.core.errors import ConflictError


class Status(StrEnum):
    INITIATED = "initiated"
    ADDRESS_SET = "address_set"
    SHIPPING_SET = "shipping_set"
    PAYMENT_PENDING = "payment_pending"
    CONFIRMED = "confirmed"
    FAILED = "failed"
    EXPIRED = "expired"
    ABANDONED = "abandoned"


ALLOWED: dict[Status, frozenset[Status]] = {
    Status.INITIATED: frozenset({Status.ADDRESS_SET, Status.EXPIRED, Status.ABANDONED}),
    Status.ADDRESS_SET: frozenset(
        {Status.ADDRESS_SET, Status.SHIPPING_SET, Status.EXPIRED, Status.ABANDONED}
    ),
    Status.SHIPPING_SET: frozenset(
        {
            Status.ADDRESS_SET,
            Status.SHIPPING_SET,
            Status.PAYMENT_PENDING,
            Status.EXPIRED,
            Status.ABANDONED,
        }
    ),
    Status.PAYMENT_PENDING: frozenset({Status.CONFIRMED, Status.FAILED, Status.EXPIRED}),
    Status.FAILED: frozenset(
        {Status.PAYMENT_PENDING, Status.CONFIRMED, Status.EXPIRED, Status.ABANDONED}
    ),
    Status.CONFIRMED: frozenset(),  # terminal — an order exists
    # Only a payment that already happened moves these on.
    Status.EXPIRED: frozenset({Status.CONFIRMED}),
    Status.ABANDONED: frozenset({Status.CONFIRMED}),
}

# Still holding stock: the sweeper expires these once their time is up.
OPEN = frozenset(
    {
        Status.INITIATED,
        Status.ADDRESS_SET,
        Status.SHIPPING_SET,
        Status.PAYMENT_PENDING,
        Status.FAILED,
    }
)
# The customer may still edit address and shipping.
EDITABLE = frozenset({Status.INITIATED, Status.ADDRESS_SET, Status.SHIPPING_SET})

_MESSAGES = {
    Status.CONFIRMED: "This checkout is complete: the order has been placed.",
    Status.EXPIRED: "This checkout has timed out. Your cart is saved.",
    Status.ABANDONED: "This checkout was cancelled. Your cart is saved.",
    Status.PAYMENT_PENDING: "Payment is in progress; this checkout can no longer be changed.",
}


class IllegalTransitionError(ConflictError):
    slug = "checkout-state"
    title = "The checkout cannot do that now"

    def __init__(self, current: Status, target: Status) -> None:
        super().__init__(
            _MESSAGES.get(current, f"A checkout that is {current} cannot become {target}.")
        )
        self.current = current
        self.target = target


def can_transition(current: Status, target: Status) -> bool:
    return target in ALLOWED[current]


def transition(current: Status | str, target: Status) -> Status:
    """``target`` if the move is allowed, else :class:`IllegalTransitionError`."""
    current = Status(current)
    if target not in ALLOWED[current]:
        raise IllegalTransitionError(current, target)
    return target
