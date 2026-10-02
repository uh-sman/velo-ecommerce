"""The checkout state machine: every legal transition, and every illegal one refused."""

from __future__ import annotations

import itertools

import pytest

from velo.domains.checkout.models import CHECKOUT_STATUSES
from velo.domains.checkout.state import (
    ALLOWED,
    IllegalTransitionError,
    Status,
    can_transition,
    transition,
)

LEGAL = {
    (Status.INITIATED, Status.ADDRESS_SET),
    (Status.INITIATED, Status.EXPIRED),
    (Status.INITIATED, Status.ABANDONED),
    (Status.ADDRESS_SET, Status.ADDRESS_SET),  # a change of mind is not an error
    (Status.ADDRESS_SET, Status.SHIPPING_SET),
    (Status.ADDRESS_SET, Status.EXPIRED),
    (Status.ADDRESS_SET, Status.ABANDONED),
    (Status.SHIPPING_SET, Status.ADDRESS_SET),
    (Status.SHIPPING_SET, Status.SHIPPING_SET),
    (Status.SHIPPING_SET, Status.PAYMENT_PENDING),
    (Status.SHIPPING_SET, Status.EXPIRED),
    (Status.SHIPPING_SET, Status.ABANDONED),
    (Status.PAYMENT_PENDING, Status.CONFIRMED),
    (Status.PAYMENT_PENDING, Status.FAILED),
    (Status.PAYMENT_PENDING, Status.EXPIRED),
    (Status.FAILED, Status.PAYMENT_PENDING),  # retry
    (Status.FAILED, Status.CONFIRMED),  # the same intent, paid after a decline
    (Status.FAILED, Status.EXPIRED),
    (Status.FAILED, Status.ABANDONED),
    (Status.EXPIRED, Status.CONFIRMED),  # money that arrived late still makes an order
    (Status.ABANDONED, Status.CONFIRMED),
}


def test_the_statuses_match_the_database_check() -> None:
    assert {status.value for status in Status} == set(CHECKOUT_STATUSES)
    assert set(ALLOWED) == set(Status)


@pytest.mark.parametrize(("current", "target"), sorted(LEGAL))
def test_every_legal_transition_is_allowed(current: Status, target: Status) -> None:
    assert transition(current, target) is target
    assert can_transition(current, target)


ILLEGAL = sorted(set(itertools.product(Status, Status)) - LEGAL)


@pytest.mark.parametrize(("current", "target"), ILLEGAL)
def test_every_other_transition_is_refused(current: Status, target: Status) -> None:
    with pytest.raises(IllegalTransitionError) as caught:
        transition(current.value, target)
    assert caught.value.status_code == 409
    assert not can_transition(current, target)


def test_a_confirmed_checkout_can_never_change() -> None:
    assert ALLOWED[Status.CONFIRMED] == frozenset()


def test_the_refusal_says_why_in_the_customers_terms() -> None:
    with pytest.raises(IllegalTransitionError) as caught:
        transition(Status.CONFIRMED, Status.SHIPPING_SET)
    assert caught.value.detail == "This checkout is complete: the order has been placed."
