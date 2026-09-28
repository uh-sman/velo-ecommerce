"""Customer- and calendar-dependent discount eligibility (DiscountService._problem)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest

from velo.domains.discounts.models import Discount
from velo.domains.discounts.service import CodeProblem, Customer, DiscountService, to_pricing

NOW = datetime(2026, 9, 29, 12, tzinfo=UTC)
GUEST = Customer()
NEW = Customer(user_id=uuid.uuid4())
RETURNING = Customer(user_id=uuid.uuid4(), paid_orders=2)
SUBSCRIBER = Customer(user_id=uuid.uuid4(), marketing_opt_in=True)
STAFF = Customer(user_id=uuid.uuid4(), is_staff=True)


def row(**fields: Any) -> Discount:
    defaults: dict[str, Any] = {
        "id": uuid.uuid4(),
        "code": "CODE",
        "title": "Code",
        "type": "percentage",
        "value": Decimal(10),
        "starts_at": NOW - timedelta(days=1),
        "ends_at": None,
        "max_redemptions": None,
        "max_per_customer": None,
        "times_redeemed": 0,
        "first_order_only": False,
        "customer_segment": "all",
    }
    return Discount(**{**defaults, **fields})


def problem(discount: Discount, customer: Customer = NEW, used: int = 0) -> CodeProblem | None:
    return DiscountService._problem(discount, customer, used, NOW)


def test_an_ordinary_code_is_fine() -> None:
    assert problem(row()) is None


@pytest.mark.parametrize(
    ("fields", "expected"),
    [
        ({"starts_at": NOW + timedelta(seconds=1)}, CodeProblem.NOT_STARTED),
        ({"ends_at": NOW}, CodeProblem.EXPIRED),  # the end is exclusive
        ({"max_redemptions": 5, "times_redeemed": 5}, CodeProblem.USED_UP),
        ({"max_redemptions": 5, "times_redeemed": 4}, None),
    ],
)
def test_the_calendar_and_the_global_limit(
    fields: dict[str, Any], expected: CodeProblem | None
) -> None:
    assert problem(row(**fields)) is expected


def test_the_per_customer_limit_counts_this_customers_redemptions() -> None:
    discount = row(max_per_customer=1)

    assert problem(discount, used=0) is None
    assert problem(discount, used=1) is CodeProblem.ALREADY_USED


def test_first_order_codes() -> None:
    discount = row(first_order_only=True)

    assert problem(discount, NEW) is None
    assert problem(discount, RETURNING) is CodeProblem.FIRST_ORDER_ONLY
    # A guest's history is unknown until checkout: provisionally allowed, re-checked there.
    assert problem(discount, GUEST) is None


@pytest.mark.parametrize(
    ("segment", "allowed"),
    [
        ("all", {GUEST, NEW, RETURNING, SUBSCRIBER, STAFF}),
        ("returning", {RETURNING}),
        ("subscribers", {SUBSCRIBER}),
        ("staff", {STAFF}),
        ("unknown-segment", set()),  # fail closed
    ],
)
def test_segments(segment: str, allowed: set[Customer]) -> None:
    discount = row(customer_segment=segment)

    for customer in (GUEST, NEW, RETURNING, SUBSCRIBER, STAFF):
        expected = None if customer in allowed else CodeProblem.NOT_ELIGIBLE
        assert problem(discount, customer) is expected, customer


def test_a_row_becomes_an_engine_discount() -> None:
    target = uuid.uuid4()
    discount = to_pricing(
        row(
            type="buy_x_get_y",
            value=Decimal(50),
            buy_quantity=2,
            get_quantity=1,
            applies_to="products",
            target_ids=[target],
            is_stackable=True,
            min_subtotal_amount=5000,
        )
    )

    assert (discount.buy_quantity, discount.get_quantity) == (2, 1)
    assert discount.target_ids == frozenset({target})
    assert discount.stackable is True
    assert discount.min_subtotal == 5000
