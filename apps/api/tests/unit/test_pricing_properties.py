"""Properties of the pricing engine that must hold for every cart (PLANNING.md Phase 7).

Hypothesis generates carts, discounts, shipping options and tax rules, and each
test states an invariant: totals are never negative, discounts never exceed the
subtotal, the parts always add up to the total, and rounding never loses or
invents a cent.
"""

from __future__ import annotations

import uuid
from decimal import Decimal
from fractions import Fraction

from hypothesis import given, settings
from hypothesis import strategies as st

from velo.domains.cart.pricing import (
    Discount,
    Line,
    PricingInput,
    PricingResult,
    ShippingOption,
    TaxRule,
    allocate,
    price_cart,
    round_minor,
)

PRODUCTS = [uuid.UUID(int=100 + n) for n in range(4)]
COLLECTIONS = [uuid.UUID(int=200 + n) for n in range(3)]
_ids = st.integers(min_value=1, max_value=10**9).map(lambda n: uuid.UUID(int=n))

lines = st.lists(
    st.builds(
        Line,
        id=_ids,
        product_id=st.sampled_from(PRODUCTS),
        unit_price=st.integers(min_value=0, max_value=250_000),
        quantity=st.integers(min_value=1, max_value=30),
        collection_ids=st.frozensets(st.sampled_from(COLLECTIONS), max_size=2),
        weight_grams=st.integers(min_value=0, max_value=5_000),
        taxable=st.booleans(),
        requires_shipping=st.booleans(),
    ),
    max_size=8,
    unique_by=lambda line: line.id,
)


@st.composite
def discounts(draw: st.DrawFn) -> Discount:
    kind = draw(st.sampled_from(["percentage", "fixed_amount", "free_shipping", "buy_x_get_y"]))
    applies_to = draw(st.sampled_from(["all", "products", "collections"]))
    targets = (
        draw(st.frozensets(st.sampled_from(PRODUCTS), min_size=1))
        if applies_to == "products"
        else draw(st.frozensets(st.sampled_from(COLLECTIONS), min_size=1))
        if applies_to == "collections"
        else frozenset()
    )
    if kind in ("percentage", "buy_x_get_y"):
        value = draw(st.decimals(min_value=Decimal("0.01"), max_value=100, places=2))
    elif kind == "fixed_amount":
        value = Decimal(draw(st.integers(min_value=1, max_value=500_000)))
    else:
        value = Decimal(0)
    return Discount(
        id=draw(_ids),
        title=kind,
        type=kind,
        value=value,
        code=draw(st.sampled_from([None, "CODE", "OTHER"])),
        currency=draw(st.sampled_from(["USD", "USD", "EUR"])),
        min_subtotal=draw(st.none() | st.integers(min_value=0, max_value=500_000)),
        applies_to=applies_to,
        target_ids=targets,
        stackable=draw(st.booleans()),
        buy_quantity=draw(st.integers(min_value=1, max_value=4)),
        get_quantity=draw(st.integers(min_value=1, max_value=3)),
    )


shipping_options = st.none() | st.lists(
    st.builds(
        ShippingOption,
        id=_ids,
        name=st.just("rate"),
        price=st.integers(min_value=0, max_value=10_000),
        min_subtotal=st.none() | st.integers(min_value=0, max_value=200_000),
        max_subtotal=st.none() | st.integers(min_value=0, max_value=2_000_000),
        min_weight_grams=st.none() | st.integers(min_value=0, max_value=50_000),
        max_weight_grams=st.none() | st.integers(min_value=0, max_value=500_000),
        position=st.integers(min_value=0, max_value=5),
    ),
    max_size=4,
)

tax_rules = st.none() | st.lists(
    st.builds(
        TaxRule,
        id=_ids,
        name=st.just("tax"),
        rate=st.decimals(min_value=0, max_value=Decimal("0.25"), places=4),
        inclusive=st.booleans(),
    ),
    max_size=3,
    unique_by=lambda rule: rule.id,
)

carts = st.builds(
    PricingInput,
    currency=st.just("USD"),
    lines=lines,
    discounts=st.lists(discounts(), max_size=5, unique_by=lambda d: d.id),
    applied_code=st.sampled_from([None, "code", "CODE", "missing"]),
    shipping_options=shipping_options,
    tax_rules=tax_rules,
)

PROFILE = settings(max_examples=400, deadline=None)


@PROFILE
@given(carts)
def test_nothing_is_ever_negative(cart: PricingInput) -> None:
    result = price_cart(cart)

    assert result.total >= 0
    assert result.subtotal >= 0
    assert all(line.total >= 0 and line.discount >= 0 and line.tax >= 0 for line in result.lines)
    assert result.shipping is None or result.shipping >= 0
    assert result.tax is None or result.tax >= 0


@PROFILE
@given(carts)
def test_discounts_never_exceed_what_they_discount(cart: PricingInput) -> None:
    result = price_cart(cart)

    assert 0 <= result.discount <= result.subtotal
    for priced in result.lines:
        assert priced.discount <= priced.subtotal
    if result.shipping_before_discount is not None:
        assert result.shipping is not None
        assert 0 <= result.shipping <= result.shipping_before_discount


@PROFILE
@given(carts)
def test_the_parts_always_add_up_to_the_total(cart: PricingInput) -> None:
    result = price_cart(cart)
    shipping, tax = result.shipping or 0, result.tax or 0

    assert sum(line.total for line in result.lines) + shipping == result.total
    assert result.subtotal - result.discount + shipping + tax == result.total
    assert sum(line.subtotal for line in result.lines) == result.subtotal
    assert sum(line.discount for line in result.lines) == result.discount
    assert sum(line.tax for line in result.lines) == tax
    product_discounts = [d for d in result.discounts if d.type != "free_shipping"]
    assert sum(d.amount for d in product_discounts) == result.discount


@PROFILE
@given(carts)
def test_every_rate_is_rounded_exactly_once(cart: PricingInput) -> None:
    result = price_cart(cart)
    lines_by_id = {line.id: line for line in cart.lines}
    base = sum(
        priced.subtotal - priced.discount
        for priced in result.lines
        if lines_by_id[priced.id].taxable
    )
    rules = cart.tax_rules or []
    inclusive_rate = sum((rule.rate for rule in rules if rule.inclusive), Decimal(0))

    for tax_line in result.tax_lines:
        exact = (
            Decimal(base) * tax_line.rate / (1 + inclusive_rate)
            if tax_line.inclusive
            else Decimal(base) * tax_line.rate
        )
        assert tax_line.amount == round_minor(exact)
        assert abs(Decimal(tax_line.amount) - exact) <= Decimal("0.5")


@PROFILE
@given(carts, st.randoms(use_true_random=False))
def test_the_result_does_not_depend_on_input_order(cart: PricingInput, rng: object) -> None:
    import random

    assert isinstance(rng, random.Random)
    shuffled_lines = list(cart.lines)
    shuffled_discounts = list(cart.discounts)
    rng.shuffle(shuffled_lines)
    rng.shuffle(shuffled_discounts)

    original = price_cart(cart)
    shuffled = price_cart(
        PricingInput(
            currency=cart.currency,
            lines=shuffled_lines,
            discounts=shuffled_discounts,
            applied_code=cart.applied_code,
            shipping_options=cart.shipping_options,
            tax_rules=cart.tax_rules,
        )
    )

    assert _summary(original) == _summary(shuffled)


def _summary(result: PricingResult) -> tuple[object, ...]:
    return (
        result.subtotal,
        result.discount,
        sorted((str(d.id), d.amount) for d in result.discounts),
        result.shipping,
        result.tax,
        result.tax_included,
        result.total,
    )


@PROFILE
@given(carts)
def test_discounts_never_raise_the_total(cart: PricingInput) -> None:
    with_discounts = price_cart(cart)
    without = price_cart(
        PricingInput(
            currency=cart.currency,
            lines=cart.lines,
            shipping_options=cart.shipping_options,
            tax_rules=cart.tax_rules,
        )
    )

    # A product discount can move the cart into a pricier shipping band (a free
    # threshold no longer met), so compare what discounts control: merchandise.
    assert with_discounts.subtotal - with_discounts.discount <= without.subtotal


@settings(max_examples=1000, deadline=None)
@given(
    st.integers(min_value=0, max_value=10**9),
    st.lists(st.integers(min_value=0, max_value=10**7), min_size=1, max_size=20),
)
def test_allocation_never_loses_or_invents_a_cent(total: int, weights: list[int]) -> None:
    if sum(weights) == 0:
        weights = [*weights[:-1], 1]

    parts = allocate(total, weights)

    assert sum(parts) == total
    whole = sum(weights)
    for part, weight in zip(parts, weights, strict=True):
        exact = Fraction(total * weight, whole)
        assert exact - 1 < part < exact + 1  # within a cent of its exact share
