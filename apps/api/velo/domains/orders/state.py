"""The order state machines — PLANNING.md Phase 9. Pure; no I/O.

Three things move independently on an order, and each has its own column:

- ``status`` — the order's life: ``pending → paid → processing →
  partially_fulfilled → fulfilled → delivered``, or ``cancelled``. A refund
  before anything ships also shows here (``partially_refunded``,
  ``refunded``), because for an unshipped order the refund *is* its story.
- ``payment_status`` — the money: ``paid``, ``partially_refunded``,
  ``refunded``. Set only from the refund ledger.
- ``fulfilment_status`` — the goods: ``unfulfilled``, ``partially_fulfilled``,
  ``fulfilled``, ``returned``. Derived from line quantities, never typed.

Anything absent from :data:`ALLOWED` is refused as :class:`IllegalOrderTransitionError`
(409). Returns have their own small machine, :data:`RETURN_ALLOWED`.
"""

from __future__ import annotations

from enum import StrEnum

from velo.core.errors import ConflictError


class OrderStatus(StrEnum):
    PENDING = "pending"
    PAID = "paid"
    PROCESSING = "processing"
    PARTIALLY_FULFILLED = "partially_fulfilled"
    FULFILLED = "fulfilled"
    DELIVERED = "delivered"
    CANCELLED = "cancelled"
    REFUNDED = "refunded"
    PARTIALLY_REFUNDED = "partially_refunded"


S = OrderStatus

# Before anything ships: the states an operator may still cancel from.
UNSHIPPED = frozenset({S.PAID, S.PARTIALLY_REFUNDED, S.PROCESSING})

ALLOWED: dict[OrderStatus, frozenset[OrderStatus]] = {
    S.PENDING: frozenset({S.PAID, S.CANCELLED}),
    S.PAID: frozenset(
        {
            S.PROCESSING,
            S.PARTIALLY_FULFILLED,
            S.FULFILLED,
            S.CANCELLED,
            S.PARTIALLY_REFUNDED,
            S.REFUNDED,
        }
    ),
    # Part of the money returned before shipping; the rest of the order goes on.
    S.PARTIALLY_REFUNDED: frozenset(
        {
            S.PROCESSING,
            S.PARTIALLY_FULFILLED,
            S.FULFILLED,
            S.CANCELLED,
            S.PARTIALLY_REFUNDED,
            S.REFUNDED,
        }
    ),
    S.PROCESSING: frozenset({S.PARTIALLY_FULFILLED, S.FULFILLED, S.CANCELLED}),
    S.PARTIALLY_FULFILLED: frozenset({S.PARTIALLY_FULFILLED, S.FULFILLED}),
    S.FULFILLED: frozenset({S.DELIVERED}),
    S.DELIVERED: frozenset(),
    S.CANCELLED: frozenset(),
    # Every penny back before shipping: nothing left to do.
    S.REFUNDED: frozenset(),
}

# What an operator may set by hand. The rest follow from an action: a
# fulfilment, a cancellation, a refund.
MANUAL_TARGETS = frozenset({S.PROCESSING, S.DELIVERED})


class IllegalOrderTransitionError(ConflictError):
    slug = "order-state"
    title = "That change is not possible for this order"


def can_transition(current: str, target: str) -> bool:
    try:
        return OrderStatus(target) in ALLOWED[OrderStatus(current)]
    except ValueError:
        return False


def transition(current: str, target: str) -> OrderStatus:
    if not can_transition(current, target):
        raise IllegalOrderTransitionError(f"An order that is {current} cannot become {target}.")
    return OrderStatus(target)


def fulfilment_status(lines: list[tuple[int, int, int]]) -> str:
    """From ``(ordered, fulfilled, returned)`` per line, the order's fulfilment status."""
    ordered = sum(line[0] for line in lines)
    fulfilled = sum(line[1] for line in lines)
    returned = sum(line[2] for line in lines)
    if fulfilled == 0:
        return "unfulfilled"
    if returned and returned == fulfilled:
        return "returned"
    return "fulfilled" if fulfilled >= ordered else "partially_fulfilled"


def payment_status(captured: int, refunded: int) -> str:
    if refunded <= 0:
        return "paid"
    return "refunded" if refunded >= captured else "partially_refunded"


# ── Returns ───────────────────────────────────────────────────────────────────


class ReturnStatus(StrEnum):
    REQUESTED = "requested"
    APPROVED = "approved"
    REJECTED = "rejected"
    IN_TRANSIT = "in_transit"
    RECEIVED = "received"
    REFUNDED = "refunded"
    CLOSED = "closed"


R = ReturnStatus

RETURN_ALLOWED: dict[ReturnStatus, frozenset[ReturnStatus]] = {
    R.REQUESTED: frozenset({R.APPROVED, R.REJECTED}),
    R.APPROVED: frozenset({R.IN_TRANSIT, R.RECEIVED, R.CLOSED}),
    R.IN_TRANSIT: frozenset({R.RECEIVED}),
    R.RECEIVED: frozenset({R.REFUNDED, R.CLOSED}),
    R.REFUNDED: frozenset({R.CLOSED}),
    R.REJECTED: frozenset({R.CLOSED}),
    R.CLOSED: frozenset(),
}

# A return in one of these still holds its quantities against new requests.
OPEN_RETURNS = frozenset({R.REQUESTED, R.APPROVED, R.IN_TRANSIT, R.RECEIVED})


class IllegalReturnTransitionError(ConflictError):
    slug = "return-state"
    title = "That change is not possible for this return"


def return_transition(current: str, target: str) -> ReturnStatus:
    try:
        allowed = ReturnStatus(target) in RETURN_ALLOWED[ReturnStatus(current)]
    except ValueError:
        allowed = False
    if not allowed:
        raise IllegalReturnTransitionError(f"A return that is {current} cannot become {target}.")
    return ReturnStatus(target)
