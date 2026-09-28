"""The pricing engine, by example: every discount type and every stacking rule.

Property-based tests (test_pricing_properties.py) cover what must hold for all
inputs; these pin down what the rules mean for particular ones.
"""

from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Any

import pytest

from velo.domains.cart.pricing import (
    Discount,
    Ineligible,
    Line,
    PricingInput,
    PricingResult,
    ShippingOption,
    TaxRule,
    allocate,
    price_cart,
    round_minor,
)


def uid(n: int) -> uuid.UUID:
    return uuid.UUID(int=n)


P1, P2, P3 = uid(101), uid(102), uid(103)  # products
C_SALE = uid(201)  # a collection


def line(n: int, price: int, qty: int = 1, product: uuid.UUID = P1, **extra: Any) -> Line:
    return Line(id=uid(n), product_id=product, unit_price=price, quantity=qty, **extra)


def percent(n: int, value: str, **extra: Any) -> Discount:
    return Discount(
        id=uid(n), title=f"{value}% off", type="percentage", value=Decimal(value), **extra
    )


def fixed(n: int, amount: int, **extra: Any) -> Discount:
    return Discount(
        id=uid(n),
        title=f"{amount} off",
        type="fixed_amount",
        value=Decimal(amount),
        currency="USD",
        **extra,
    )


def bxgy(n: int, buy: int, get: int, value: str = "100", **extra: Any) -> Discount:
    return Discount(
        id=uid(n),
        title=f"Buy {buy} get {get}",
        type="buy_x_get_y",
        value=Decimal(value),
        buy_quantity=buy,
        get_quantity=get,
        **extra,
    )


def free_shipping(n: int, **extra: Any) -> Discount:
    return Discount(
        id=uid(n), title="Free shipping", type="free_shipping", value=Decimal(0), **extra
    )


def price(*lines: Line, **extra: Any) -> PricingResult:
    return price_cart(PricingInput(currency="USD", lines=lines, **extra))


# ── Rounding and allocation ───────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("exact", "minor"),
    [("0.5", 1), ("1.5", 2), ("2.5", 3), ("-0.5", -1), ("1.49", 1), ("1.4999", 1), ("0", 0)],
)
def test_rounding_is_half_up(exact: str, minor: int) -> None:
    assert round_minor(Decimal(exact)) == minor


@pytest.mark.parametrize(
    ("total", "weights", "parts"),
    [
        (100, [1, 1, 1], [34, 33, 33]),  # the leftover cent goes to the earliest tie
        (10, [3, 7], [3, 7]),
        (1, [5, 5], [1, 0]),
        (0, [0, 0], [0, 0]),
        (7, [0, 5], [0, 7]),
    ],
)
def test_allocation_is_exact(total: int, weights: list[int], parts: list[int]) -> None:
    assert allocate(total, weights) == parts
    assert sum(parts) == total


def test_allocation_refuses_impossible_splits() -> None:
    with pytest.raises(ValueError, match="negative"):
        allocate(-1, [1])
    with pytest.raises(ValueError, match="zero weights"):
        allocate(1, [0, 0])


# ── Lines and totals ──────────────────────────────────────────────────────────


def test_a_plain_cart_totals_its_lines() -> None:
    result = price(line(1, 2800, 2), line(2, 999, 3))

    assert result.subtotal == 2800 * 2 + 999 * 3 == 8597
    assert result.discount == 0
    assert result.total == 8597
    assert result.item_count == 5
    assert [(p.subtotal, p.total) for p in result.lines] == [(5600, 5600), (2997, 2997)]


def test_shipping_and_tax_are_unknown_until_the_address_is() -> None:
    result = price(line(1, 1000))

    assert (result.shipping, result.tax, result.tax_included) == (None, None, None)
    assert result.total == 1000


def test_an_empty_cart_is_zero() -> None:
    result = price()

    assert (result.subtotal, result.total, result.shipping) == (0, 0, 0)


# ── Each discount type ────────────────────────────────────────────────────────


def test_percentage_rounds_once_on_the_whole_base() -> None:
    # 3 x 333 at 10%: per line that would be 33.3 -> 33 three times = 99;
    # on the whole base it is 99.9 -> 100. The engine rounds once.
    result = price(line(1, 333), line(2, 333), line(3, 333), discounts=[percent(1, "10")])

    assert result.discount == 100
    assert sorted(p.discount for p in result.lines) == [33, 33, 34]


def test_fixed_amount_is_capped_at_the_merchandise() -> None:
    small = price(line(1, 1500), discounts=[fixed(1, 2000)])
    normal = price(line(1, 1500), line(2, 500), discounts=[fixed(1, 1000)])

    assert (small.discount, small.total) == (1500, 0)
    assert normal.discount == 1000
    assert [p.discount for p in normal.lines] == [750, 250]  # in proportion


def test_fixed_amount_in_another_currency_does_not_apply() -> None:
    euros = Discount(
        id=uid(1), title="EUR", type="fixed_amount", value=Decimal(500), currency="EUR"
    )

    result = price(line(1, 1000), discounts=[euros])

    assert result.discount == 0
    assert result.rejected[uid(1)] is Ineligible.CURRENCY


def test_buy_two_get_one_free_discounts_the_cheapest_in_each_group() -> None:
    # Units by price: 3000, 3000, 2000 | 2000, 1000, 1000 -> free: 2000 and 1000.
    result = price(line(1, 3000, 2), line(2, 2000, 2), line(3, 1000, 2), discounts=[bxgy(1, 2, 1)])

    assert result.discount == 3000
    assert [p.discount for p in result.lines] == [0, 2000, 1000]


def test_buy_one_get_one_half_off() -> None:
    result = price(line(1, 1999, 2), discounts=[bxgy(1, 1, 1, value="50")])

    assert result.discount == 1000  # 999.5, rounded half up, once


def test_buy_x_get_y_needs_a_whole_group() -> None:
    result = price(line(1, 1000, 2), discounts=[bxgy(1, 2, 1)])

    assert result.discount == 0
    assert result.rejected[uid(1)] is Ineligible.NOT_ENOUGH_ITEMS


def test_free_shipping_zeroes_shipping_and_nothing_else() -> None:
    options = [ShippingOption(id=uid(9), name="Standard", price=599)]

    result = price(line(1, 2000), discounts=[free_shipping(1)], shipping_options=options)

    assert (result.shipping_before_discount, result.shipping) == (599, 0)
    assert result.discount == 0
    assert result.discounts[0].amount == 599
    assert result.total == 2000


def test_free_shipping_does_nothing_when_nothing_ships() -> None:
    digital = line(1, 2000, requires_shipping=False)

    result = price(digital, discounts=[free_shipping(1)], shipping_options=[])

    assert result.shipping == 0
    assert result.rejected[uid(1)] is Ineligible.NOTHING_TO_SHIP


# ── Eligibility that depends on the cart ──────────────────────────────────────


def test_a_minimum_subtotal_is_checked_before_discounts() -> None:
    below = price(line(1, 4999), discounts=[percent(1, "10", min_subtotal=5000)])
    at = price(line(1, 5000), discounts=[percent(1, "10", min_subtotal=5000)])

    assert below.rejected[uid(1)] is Ineligible.MIN_SUBTOTAL
    assert at.discount == 500


def test_product_and_collection_targets_limit_the_discount() -> None:
    lines = (
        line(1, 1000, product=P1),
        line(2, 2000, product=P2, collection_ids=frozenset({C_SALE})),
        line(3, 4000, product=P3),
    )
    by_product = price(
        *lines, discounts=[percent(1, "50", applies_to="products", target_ids=frozenset({P1}))]
    )
    by_collection = price(
        *lines,
        discounts=[percent(1, "50", applies_to="collections", target_ids=frozenset({C_SALE}))],
    )
    nothing = price(
        *lines,
        discounts=[percent(1, "50", applies_to="products", target_ids=frozenset({uid(999)}))],
    )

    assert [p.discount for p in by_product.lines] == [500, 0, 0]
    assert [p.discount for p in by_collection.lines] == [0, 1000, 0]
    assert nothing.rejected[uid(1)] is Ineligible.NO_TARGETS


# ── Stacking ──────────────────────────────────────────────────────────────────


def test_non_stackable_discounts_do_not_combine_the_best_one_wins() -> None:
    result = price(line(1, 10_000), discounts=[percent(1, "10"), percent(2, "15"), fixed(3, 1200)])

    assert [d.id for d in result.discounts] == [uid(2)]
    assert result.discount == 1500
    assert result.rejected == {uid(1): Ineligible.OUTCLASSED, uid(3): Ineligible.OUTCLASSED}


def test_stackable_discounts_combine_in_order_on_what_is_left() -> None:
    # bxgy first (free 1000), then 10% of the remaining 3000 (300), then 500 fixed.
    discounts = [
        fixed(3, 500, stackable=True),
        percent(2, "10", stackable=True),
        bxgy(1, 1, 1, stackable=True),
    ]

    result = price(line(1, 2000, 2), discounts=discounts)

    assert [d.type for d in result.discounts] == ["buy_x_get_y", "percentage", "fixed_amount"]
    assert [d.amount for d in result.discounts] == [2000, 200, 500]
    assert result.discount == 2700
    assert result.total == 1300


def test_stackables_together_beat_a_weaker_non_stackable() -> None:
    discounts = [percent(1, "20"), percent(2, "15", stackable=True), fixed(3, 1000, stackable=True)]

    result = price(line(1, 10_000), discounts=discounts)

    # 15% of 10000 = 1500, then 1000 fixed: 2500 together, beating 20% alone (2000).
    assert {d.id for d in result.discounts} == {uid(2), uid(3)}
    assert result.discount == 2500


def test_a_stronger_non_stackable_beats_the_stackables() -> None:
    discounts = [percent(1, "40"), percent(2, "15", stackable=True), fixed(3, 1000, stackable=True)]

    result = price(line(1, 10_000), discounts=discounts)

    assert [d.id for d in result.discounts] == [uid(1)]
    assert result.discount == 4000


def test_on_a_tie_the_customers_code_wins() -> None:
    automatic = percent(1, "10")
    coded = percent(2, "10", code="SAVE10")

    result = price(line(1, 5000), discounts=[automatic, coded], applied_code="save10")

    assert [d.code for d in result.discounts] == ["SAVE10"]


def test_on_a_tie_without_a_code_the_result_does_not_depend_on_order() -> None:
    a, b = fixed(7, 500), fixed(3, 500)

    first = price(line(1, 5000), discounts=[a, b])
    second = price(line(1, 5000), discounts=[b, a])

    assert first.discounts == second.discounts
    assert [d.id for d in first.discounts] == [uid(3)]


def test_free_shipping_combines_with_a_product_discount() -> None:
    options = [ShippingOption(id=uid(9), name="Standard", price=599)]

    result = price(
        line(1, 10_000), discounts=[percent(1, "10"), free_shipping(2)], shipping_options=options
    )

    assert {d.type for d in result.discounts} == {"percentage", "free_shipping"}
    assert result.total == 9000


def test_only_one_free_shipping_applies_preferring_the_code() -> None:
    options = [ShippingOption(id=uid(9), name="Standard", price=599)]
    auto, coded = free_shipping(1), free_shipping(2, code="SHIPFREE")

    result = price(
        line(1, 1000), discounts=[auto, coded], applied_code="SHIPFREE", shipping_options=options
    )

    assert [d.id for d in result.discounts] == [uid(2)]
    assert result.rejected[uid(1)] is Ineligible.OUTCLASSED


# ── Shipping ──────────────────────────────────────────────────────────────────

STANDARD = ShippingOption(id=uid(11), name="Standard", price=599, max_subtotal=7499, position=0)
FREE_OVER_75 = ShippingOption(id=uid(12), name="Free", price=0, min_subtotal=7500, position=1)
EXPRESS = ShippingOption(id=uid(13), name="Express", price=1499, position=2)
HEAVY = ShippingOption(id=uid(14), name="Freight", price=4999, min_weight_grams=20_000)


def test_the_cheapest_fitting_rate_is_the_default() -> None:
    small = price(
        line(1, 5000, weight_grams=500), shipping_options=[STANDARD, FREE_OVER_75, EXPRESS]
    )
    large = price(
        line(1, 8000, weight_grams=500), shipping_options=[STANDARD, FREE_OVER_75, EXPRESS]
    )

    assert (small.shipping_option, small.shipping) == (STANDARD, 599)
    assert [o.name for o in small.shipping_options] == ["Standard", "Express"]
    assert (large.shipping_option, large.shipping) == (FREE_OVER_75, 0)


def test_a_chosen_rate_is_honoured_if_it_fits() -> None:
    chosen = price(
        line(1, 5000), shipping_options=[STANDARD, EXPRESS], selected_shipping_id=EXPRESS.id
    )
    unfit = price(
        line(1, 5000),
        shipping_options=[STANDARD, FREE_OVER_75],
        selected_shipping_id=FREE_OVER_75.id,
    )

    assert chosen.shipping == 1499
    assert unfit.shipping_option == STANDARD


def test_the_free_threshold_counts_merchandise_after_discounts() -> None:
    # 8000 qualifies for free shipping; 10% off makes it 7200, which does not.
    result = price(
        line(1, 8000), discounts=[percent(1, "10")], shipping_options=[STANDARD, FREE_OVER_75]
    )

    assert result.shipping == 599


def test_weight_bands_select_rates() -> None:
    light = price(line(1, 1000, 2, weight_grams=500), shipping_options=[EXPRESS, HEAVY])
    heavy = price(line(1, 1000, 25, weight_grams=1000), shipping_options=[HEAVY])

    assert light.shipping_option == EXPRESS
    assert heavy.shipping_option == HEAVY


def test_no_rate_for_the_address_leaves_shipping_unknown() -> None:
    result = price(line(1, 1000, weight_grams=100), shipping_options=[HEAVY])

    assert result.shipping is None
    assert result.shipping_options == []


def test_only_lines_that_ship_count_towards_weight() -> None:
    lines = (
        line(1, 1000, weight_grams=15_000),
        line(2, 500, 10, weight_grams=1000, requires_shipping=False),
    )

    result = price(*lines, shipping_options=[EXPRESS, HEAVY])

    assert result.shipping_option == EXPRESS  # 15 kg, not 25 kg


# ── Tax ───────────────────────────────────────────────────────────────────────

CA = TaxRule(id=uid(21), name="CA sales tax", rate=Decimal("0.0725"))
CITY = TaxRule(id=uid(22), name="City tax", rate=Decimal("0.01"))
VAT = TaxRule(id=uid(23), name="VAT", rate=Decimal("0.20"), inclusive=True)


def test_exclusive_tax_is_added_after_discounts_and_not_on_shipping() -> None:
    result = price(
        line(1, 10_000),
        discounts=[percent(1, "10")],
        shipping_options=[EXPRESS],
        tax_rules=[CA],
    )

    assert result.tax == 653  # 7.25% of 9000 = 652.5 -> 653
    assert result.total == 9000 + 1499 + 653


def test_several_exclusive_rates_each_round_once() -> None:
    result = price(line(1, 3333), line(2, 3333), tax_rules=[CA, CITY])

    assert [t.amount for t in result.tax_lines] == [483, 67]  # 483.285 and 66.66
    assert result.tax == 550
    assert sum(p.tax for p in result.lines) == 550


def test_untaxed_lines_are_not_taxed() -> None:
    result = price(line(1, 1000), line(2, 1000, taxable=False), tax_rules=[CA])

    assert result.tax == 73
    assert [p.tax for p in result.lines] == [73, 0]


def test_inclusive_tax_is_reported_not_added() -> None:
    result = price(line(1, 12_000), tax_rules=[VAT])

    assert result.tax == 0
    assert result.tax_included == 2000  # 12000 contains 20% VAT: 12000 / 1.2 x 0.2
    assert result.total == 12_000


def test_a_known_address_with_no_tax_is_zero_not_unknown() -> None:
    result = price(line(1, 1000), tax_rules=[])

    assert (result.tax, result.tax_included) == (0, 0)


def test_totals_add_up_from_the_lines() -> None:
    result = price(
        line(1, 2999, 3),
        line(2, 1499, 1, taxable=False),
        discounts=[percent(1, "15", stackable=True), fixed(2, 700, stackable=True)],
        shipping_options=[STANDARD, EXPRESS],
        tax_rules=[CA, CITY],
    )

    assert sum(p.total for p in result.lines) + (result.shipping or 0) == result.total
    assert (
        result.subtotal - result.discount + (result.tax or 0) + (result.shipping or 0)
        == result.total
    )
