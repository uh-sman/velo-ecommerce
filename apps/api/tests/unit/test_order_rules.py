"""Order state machines and arithmetic (PLANNING.md Phase 9)."""

from __future__ import annotations

import uuid

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from velo.domains.orders.rules import (
    line_share,
    order_token,
    refundable,
    shipping_share,
    verify_order_token,
)
from velo.domains.orders.state import (
    ALLOWED,
    IllegalOrderTransitionError,
    IllegalReturnTransitionError,
    OrderStatus,
    fulfilment_status,
    payment_status,
    return_transition,
    transition,
)


class TestOrderStateMachine:
    def test_every_status_has_a_row(self) -> None:
        assert set(ALLOWED) == set(OrderStatus)

    @pytest.mark.parametrize(
        ("current", "target"),
        [
            ("paid", "processing"),
            ("paid", "cancelled"),
            ("processing", "partially_fulfilled"),
            ("partially_fulfilled", "fulfilled"),
            ("fulfilled", "delivered"),
            ("partially_refunded", "fulfilled"),
        ],
    )
    def test_allowed(self, current: str, target: str) -> None:
        assert transition(current, target) == target

    @pytest.mark.parametrize(
        ("current", "target"),
        [
            ("fulfilled", "cancelled"),  # it has shipped
            ("delivered", "processing"),
            ("cancelled", "paid"),
            ("refunded", "processing"),
            ("paid", "delivered"),  # never delivered without being sent
            ("paid", "nonsense"),
        ],
    )
    def test_refused(self, current: str, target: str) -> None:
        with pytest.raises(IllegalOrderTransitionError):
            transition(current, target)

    def test_terminal_states_go_nowhere(self) -> None:
        for status in ("delivered", "cancelled", "refunded"):
            assert ALLOWED[OrderStatus(status)] == frozenset()


class TestDerivedStatuses:
    def test_fulfilment(self) -> None:
        assert fulfilment_status([(2, 0, 0), (1, 0, 0)]) == "unfulfilled"
        assert fulfilment_status([(2, 1, 0), (1, 0, 0)]) == "partially_fulfilled"
        assert fulfilment_status([(2, 2, 0), (1, 1, 0)]) == "fulfilled"
        assert fulfilment_status([(2, 2, 1), (1, 1, 0)]) == "fulfilled"
        assert fulfilment_status([(2, 2, 2), (1, 1, 1)]) == "returned"

    def test_payment(self) -> None:
        assert payment_status(1000, 0) == "paid"
        assert payment_status(1000, 1) == "partially_refunded"
        assert payment_status(1000, 1000) == "refunded"


class TestReturns:
    def test_happy_path(self) -> None:
        status = "requested"
        for target in ("approved", "in_transit", "received", "refunded", "closed"):
            status = return_transition(status, target)
        assert status == "closed"

    @pytest.mark.parametrize(
        ("current", "target"),
        [("requested", "received"), ("rejected", "approved"), ("closed", "requested")],
    )
    def test_refused(self, current: str, target: str) -> None:
        with pytest.raises(IllegalReturnTransitionError):
            return_transition(current, target)


class TestLineShare:
    def test_simple(self) -> None:
        assert line_share(3000, 3, 0, 1) == 1000
        assert line_share(3000, 3, 0, 3) == 3000

    def test_no_cent_lost_to_rounding(self) -> None:
        # 1000 over 3 units: 333, 333, 334 — and the three add up.
        parts = [line_share(1000, 3, done, 1) for done in range(3)]
        assert parts == [333, 333, 334]
        assert sum(parts) == 1000

    def test_never_beyond_the_line(self) -> None:
        assert line_share(1000, 2, 2, 1) == 0
        assert line_share(1000, 2, 1, 5) == 500

    # st.data() draws per line, which a loaded CI box can find slow; that is not a failure.
    @settings(suppress_health_check=[HealthCheck.too_slow])
    @given(
        total=st.integers(min_value=0, max_value=10**9),
        quantity=st.integers(min_value=1, max_value=50),
        data=st.data(),
    )
    def test_any_split_sums_to_the_total(
        self, total: int, quantity: int, data: st.DataObject
    ) -> None:
        done = 0
        refunded = 0
        while done < quantity:
            units = data.draw(st.integers(min_value=1, max_value=quantity - done))
            refunded += line_share(total, quantity, done, units)
            done += units
        assert refunded == total


def test_shipping_share_and_ceiling() -> None:
    assert shipping_share(6962, [6363]) == 599
    assert shipping_share(100, [150]) == 0
    assert refundable(5000, 4000) == 1000
    assert refundable(5000, 6000) == 0


def test_order_token() -> None:
    order_id = uuid.uuid4()
    token = order_token("s" * 32, order_id)
    assert verify_order_token("s" * 32, order_id, token)
    assert not verify_order_token("s" * 32, uuid.uuid4(), token)
    assert not verify_order_token("t" * 32, order_id, token)
    assert not verify_order_token("s" * 32, order_id, None)
