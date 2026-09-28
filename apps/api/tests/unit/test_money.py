"""The Money value object (ADR-005)."""

from __future__ import annotations

from decimal import Decimal

import pytest

from velo.core.money import CurrencyMismatchError, Money


def test_addition_and_subtraction_are_exact() -> None:
    # The float version of this sum is 0.30000000000000004.
    assert Money(10, "USD") + Money(20, "USD") == Money(30, "USD")
    assert Money(30, "USD") - Money(45, "USD") == Money(-15, "USD")


def test_multiplication_by_a_quantity() -> None:
    assert Money(2999, "USD") * 3 == Money(8997, "USD")
    assert 3 * Money(2999, "USD") == Money(8997, "USD")


@pytest.mark.parametrize("amount", [29.99, Decimal("29.99"), "2999", True])
def test_non_integer_amounts_are_refused(amount: object) -> None:
    with pytest.raises(TypeError):
        Money(amount, "USD")  # type: ignore[arg-type]


@pytest.mark.parametrize("quantity", [1.5, Decimal("2"), True])
def test_multiplying_by_a_non_integer_is_refused(quantity: object) -> None:
    with pytest.raises(TypeError):
        Money(100, "USD") * quantity  # type: ignore[operator]


@pytest.mark.parametrize("currency", ["usd", "US", "USDX", "", "12$"])
def test_currency_must_be_an_iso_code(currency: str) -> None:
    with pytest.raises(ValueError, match="ISO-4217"):
        Money(100, currency)


def test_currencies_never_mix() -> None:
    with pytest.raises(CurrencyMismatchError):
        Money(100, "USD") + Money(100, "EUR")
    with pytest.raises(CurrencyMismatchError):
        _ = Money(100, "USD") < Money(100, "EUR")


def test_comparisons_and_predicates() -> None:
    assert Money(100, "USD") < Money(200, "USD")
    assert Money(200, "USD") >= Money(200, "USD")
    assert Money.zero("NGN").is_zero
    assert (-Money(5, "USD")).is_negative
