"""The pricing engine — pure functions, no I/O (ARCHITECTURE.md §3).

Given what is in a cart, the discounts that could apply, the shipping options
and the tax rules for an address, :func:`price_cart` produces every number a
customer sees. The service layer gathers the inputs; nothing here reads a
database, a clock, or a request.

Money is integer minor units throughout (ADR-005).

**Rounding — one rule, one place.** Only two things multiply money by a rate:
percentage discounts and tax. Each computes an exact ``Decimal`` and converts
it to minor units in :func:`round_minor` — half up, once per discount and once
per tax rate, on the whole base, never per line. Amounts are then spread across
lines by :func:`allocate` (largest remainder), which is integer-exact: the
parts always sum to the whole. So no step loses or invents a cent.

**Stacking — precisely:**

1. Discounts are of two classes. *Product discounts* (percentage, fixed amount,
   buy-X-get-Y) reduce merchandise; *shipping discounts* (free shipping) reduce
   shipping. The classes always combine with each other.
2. At most one shipping discount applies — they are all "shipping is free".
   The customer's code is preferred, then the lowest id.
3. Product discounts: a non-stackable discount applies alone. The engine
   compares every non-stackable discount alone with all stackable discounts
   together, and applies whichever saves the customer most. Ties go to the
   choice that includes the customer's code, then to fewer discounts, then to
   the lowest ids — so the result never depends on input order.
4. Stackable product discounts apply in a fixed order — buy-X-get-Y, then
   percentage, then fixed amount — each on what the previous left, and each
   capped at what is left: a discount never takes a line below zero.
5. Eligibility that depends on the cart (minimum subtotal, target products or
   collections, enough items for buy-X-get-Y) is checked here, against the
   subtotal *before* any discount. Eligibility that depends on the customer or
   the calendar (first order, segment, usage limits, dates) is checked before
   the engine is called.

**Shipping** bands (price and weight) are matched against merchandise after
product discounts and the weight of lines that ship. **Tax** is charged on
taxable lines after product discounts; shipping is not taxed. Exclusive rates
add to the total; inclusive rates (EU VAT) are already in the price and are
reported, not added.

Unknown address → ``shipping`` and ``tax`` are ``None``: not zero. Zero is a
claim; ``None`` is the truth (API-SPEC.md §2, "Cart").
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal
from enum import StrEnum

HUNDRED = Decimal(100)

# Order in which stackable product discounts apply (stacking rule 4).
_STACK_ORDER = {"buy_x_get_y": 0, "percentage": 1, "fixed_amount": 2}


class Ineligible(StrEnum):
    """Why a cart-dependent rule refused a discount. Shown to the customer."""

    MIN_SUBTOTAL = "min_subtotal"
    NO_TARGETS = "no_targets"
    NOT_ENOUGH_ITEMS = "not_enough_items"
    CURRENCY = "currency"
    NOTHING_TO_SHIP = "nothing_to_ship"
    OUTCLASSED = "outclassed"  # eligible, but a better combination was chosen


# ── Rounding and allocation ───────────────────────────────────────────────────


def round_minor(amount: Decimal) -> int:
    """The single rounding point: an exact amount to whole minor units, half up."""
    return int(amount.to_integral_value(rounding=ROUND_HALF_UP))


def allocate(total: int, weights: Sequence[int]) -> list[int]:
    """Split ``total`` in proportion to ``weights``; the parts sum to exactly ``total``.

    Largest remainder: each part gets the floor of its share, and the leftover
    minor units go to the largest fractional remainders, earliest first on a tie.
    """
    if total < 0:
        raise ValueError("cannot allocate a negative amount")
    whole = sum(weights)
    if whole <= 0:
        if total:
            raise ValueError("cannot allocate a non-zero amount across zero weights")
        return [0] * len(weights)
    shares = [total * weight for weight in weights]
    parts = [share // whole for share in shares]
    remainders = sorted(range(len(weights)), key=lambda i: (-(shares[i] % whole), i))
    for i in remainders[: total - sum(parts)]:
        parts[i] += 1
    return parts


# ── Inputs ────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Line:
    id: uuid.UUID
    product_id: uuid.UUID
    unit_price: int
    quantity: int
    collection_ids: frozenset[uuid.UUID] = frozenset()
    compare_at: int | None = None
    weight_grams: int = 0
    taxable: bool = True
    requires_shipping: bool = True

    @property
    def subtotal(self) -> int:
        return self.unit_price * self.quantity


@dataclass(frozen=True, slots=True)
class Discount:
    id: uuid.UUID
    title: str
    type: str  # percentage | fixed_amount | free_shipping | buy_x_get_y
    value: Decimal  # percent for percentage and buy_x_get_y; minor units for fixed_amount
    code: str | None = None  # None: automatic
    currency: str | None = None
    min_subtotal: int | None = None
    applies_to: str = "all"  # all | products | collections
    target_ids: frozenset[uuid.UUID] = frozenset()
    stackable: bool = False
    buy_quantity: int = 0
    get_quantity: int = 0

    def targets(self, line: Line) -> bool:
        if self.applies_to == "products":
            return line.product_id in self.target_ids
        if self.applies_to == "collections":
            return bool(line.collection_ids & self.target_ids)
        return True


@dataclass(frozen=True, slots=True)
class ShippingOption:
    id: uuid.UUID
    name: str
    price: int
    min_subtotal: int | None = None
    max_subtotal: int | None = None
    min_weight_grams: int | None = None
    max_weight_grams: int | None = None
    position: int = 0
    est_days_min: int | None = None
    est_days_max: int | None = None

    def fits(self, merchandise: int, weight: int) -> bool:
        return (
            (self.min_subtotal is None or merchandise >= self.min_subtotal)
            and (self.max_subtotal is None or merchandise <= self.max_subtotal)
            and (self.min_weight_grams is None or weight >= self.min_weight_grams)
            and (self.max_weight_grams is None or weight <= self.max_weight_grams)
        )


@dataclass(frozen=True, slots=True)
class TaxRule:
    id: uuid.UUID
    name: str
    rate: Decimal  # 0.0725 = 7.25%
    inclusive: bool = False


@dataclass(frozen=True, slots=True)
class PricingInput:
    currency: str
    lines: Sequence[Line]
    discounts: Sequence[Discount] = ()
    applied_code: str | None = None
    # None: the address is not known yet. An empty list: known, and nothing ships there.
    shipping_options: Sequence[ShippingOption] | None = None
    selected_shipping_id: uuid.UUID | None = None
    tax_rules: Sequence[TaxRule] | None = None


# ── Outputs ───────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class PricedLine:
    id: uuid.UUID
    unit_price: int
    quantity: int
    subtotal: int  # unit_price x quantity
    discount: int  # this line's share of product discounts
    tax: int  # this line's share of exclusive tax
    total: int  # subtotal - discount + tax


@dataclass(frozen=True, slots=True)
class AppliedDiscount:
    id: uuid.UUID
    title: str
    type: str
    code: str | None
    amount: int


@dataclass(frozen=True, slots=True)
class TaxLine:
    id: uuid.UUID
    name: str
    rate: Decimal
    amount: int
    inclusive: bool


@dataclass(frozen=True, slots=True)
class PricingResult:
    currency: str
    lines: list[PricedLine]
    subtotal: int
    discount: int  # product discounts
    discounts: list[AppliedDiscount]
    rejected: dict[uuid.UUID, Ineligible]
    shipping: int | None  # after any shipping discount
    shipping_before_discount: int | None
    shipping_option: ShippingOption | None
    shipping_options: list[ShippingOption]
    tax: int | None  # exclusive tax, added to the total
    tax_included: int | None  # inclusive tax, already in the prices
    tax_lines: list[TaxLine]
    total: int
    item_count: int = field(default=0)


# ── Product discounts ─────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class _Applied:
    discount: Discount
    per_line: tuple[int, ...]  # amount taken from each line, in input order

    @property
    def amount(self) -> int:
        return sum(self.per_line)


def _eligibility(
    discount: Discount, lines: Sequence[Line], subtotal: int, currency: str
) -> Ineligible | None:
    if discount.type == "fixed_amount" and discount.currency != currency:
        return Ineligible.CURRENCY
    if discount.min_subtotal is not None and subtotal < discount.min_subtotal:
        return Ineligible.MIN_SUBTOTAL
    targeted = [line for line in lines if discount.targets(line)]
    if not targeted:
        return Ineligible.NO_TARGETS
    if discount.type == "buy_x_get_y":
        units = sum(line.quantity for line in targeted)
        if units < discount.buy_quantity + discount.get_quantity:
            return Ineligible.NOT_ENOUGH_ITEMS
    return None


def _apply(discount: Discount, lines: Sequence[Line], remaining: list[int]) -> _Applied:
    """What ``discount`` takes from each line, given what earlier discounts left."""
    eligible = [i for i, line in enumerate(lines) if discount.targets(line)]
    base = [remaining[i] if i in eligible else 0 for i in range(len(lines))]
    available = sum(base)

    if discount.type == "percentage":
        amount = min(round_minor(Decimal(available) * discount.value / HUNDRED), available)
        return _Applied(discount, tuple(allocate(amount, base)))

    if discount.type == "fixed_amount":
        amount = min(int(discount.value), available)
        return _Applied(discount, tuple(allocate(amount, base)))

    # buy_x_get_y: expand eligible units, most expensive first; every complete
    # group of (buy + get) discounts its `get` cheapest units.
    units = sorted(
        ((lines[i].unit_price, i) for i in eligible for _ in range(lines[i].quantity)),
        key=lambda unit: (-unit[0], unit[1]),
    )
    group = discount.buy_quantity + discount.get_quantity
    exact: list[Decimal] = [Decimal(0)] * len(lines)
    for start in range(0, len(units) - group + 1, group):
        for price, i in units[start + discount.buy_quantity : start + group]:
            exact[i] += Decimal(price) * discount.value / HUNDRED
    amount = min(round_minor(sum(exact, Decimal(0))), available)
    # Allocate the single rounded amount by each line's exact share, capped per line.
    weights = [round_minor(value * 10_000) for value in exact]
    per_line = allocate(amount, weights) if amount else [0] * len(lines)
    return _Applied(discount, tuple(min(part, base[i]) for i, part in enumerate(per_line)))


def _stack(discounts: Sequence[Discount], lines: Sequence[Line]) -> list[_Applied]:
    remaining = [line.subtotal for line in lines]
    applied = []
    for discount in sorted(discounts, key=lambda d: (_STACK_ORDER[d.type], str(d.id))):
        result = _apply(discount, lines, remaining)
        if result.amount > 0:
            remaining = [
                left - taken for left, taken in zip(remaining, result.per_line, strict=True)
            ]
            applied.append(result)
    return applied


def _choose(
    candidates: Sequence[Discount], lines: Sequence[Line], applied_code: str | None
) -> list[_Applied]:
    """Stacking rule 3: the best single non-stackable, or all stackables together."""
    options: list[list[_Applied]] = [
        _stack([discount], lines) for discount in candidates if not discount.stackable
    ]
    stackable = [discount for discount in candidates if discount.stackable]
    if stackable:
        options.append(_stack(stackable, lines))
    options = [option for option in options if option]
    if not options:
        return []

    code = (applied_code or "").casefold()

    def rank(option: list[_Applied]) -> tuple[int, int, int, list[str]]:
        has_code = (
            any((a.discount.code or "").casefold() == code for a in option) if code else False
        )
        return (
            -sum(a.amount for a in option),
            0 if has_code else 1,
            len(option),
            sorted(str(a.discount.id) for a in option),
        )

    return min(options, key=rank)


# ── Assembly ──────────────────────────────────────────────────────────────────


def price_cart(data: PricingInput) -> PricingResult:
    lines = list(data.lines)
    subtotal = sum(line.subtotal for line in lines)
    rejected: dict[uuid.UUID, Ineligible] = {}

    # Product discounts (stacking rules 3-5).
    product_candidates: list[Discount] = []
    shipping_candidates: list[Discount] = []
    for discount in data.discounts:
        reason = _eligibility(discount, lines, subtotal, data.currency)
        if reason is not None:
            rejected[discount.id] = reason
        elif discount.type == "free_shipping":
            shipping_candidates.append(discount)
        else:
            product_candidates.append(discount)
    chosen = _choose(product_candidates, lines, data.applied_code)
    chosen_ids = {applied.discount.id for applied in chosen}
    for discount in product_candidates:
        if discount.id not in chosen_ids:
            rejected[discount.id] = Ineligible.OUTCLASSED
    line_discounts = [0] * len(lines)
    for applied in chosen:
        line_discounts = [a + b for a, b in zip(line_discounts, applied.per_line, strict=True)]
    discount_total = sum(line_discounts)
    merchandise = subtotal - discount_total

    # Shipping.
    ships = [line for line in lines if line.requires_shipping]
    weight = sum(line.weight_grams * line.quantity for line in ships)
    shipping_option: ShippingOption | None = None
    fitting: list[ShippingOption] = []
    shipping: int | None
    if not ships:
        shipping = 0  # nothing to ship: zero is the truth here
        for discount in shipping_candidates:
            rejected[discount.id] = Ineligible.NOTHING_TO_SHIP
        shipping_candidates = []
    elif data.shipping_options is None:
        shipping = None
    else:
        fitting = sorted(
            (option for option in data.shipping_options if option.fits(merchandise, weight)),
            key=lambda option: (option.price, option.position, str(option.id)),
        )
        shipping_option = next(
            (option for option in fitting if option.id == data.selected_shipping_id),
            fitting[0] if fitting else None,
        )
        shipping = shipping_option.price if shipping_option else None
    shipping_before = shipping
    applied_discounts = [
        AppliedDiscount(a.discount.id, a.discount.title, a.discount.type, a.discount.code, a.amount)
        for a in chosen
    ]
    if shipping_candidates:
        code = (data.applied_code or "").casefold()
        free = min(
            shipping_candidates,
            key=lambda d: (0 if code and (d.code or "").casefold() == code else 1, str(d.id)),
        )
        for discount in shipping_candidates:
            if discount.id != free.id:
                rejected[discount.id] = Ineligible.OUTCLASSED
        applied_discounts.append(
            AppliedDiscount(free.id, free.title, free.type, free.code, shipping or 0)
        )
        if shipping is not None:
            shipping = 0

    # Tax.
    taxable = [
        subtotal_ - discount if line.taxable else 0
        for line, subtotal_, discount in zip(
            lines, (line.subtotal for line in lines), line_discounts, strict=True
        )
    ]
    base = sum(taxable)
    tax: int | None = None
    tax_included: int | None = None
    tax_lines: list[TaxLine] = []
    line_tax = [0] * len(lines)
    if data.tax_rules is not None:
        tax, tax_included = 0, 0
        inclusive_rate = sum((rule.rate for rule in data.tax_rules if rule.inclusive), Decimal(0))
        for rule in sorted(data.tax_rules, key=lambda r: str(r.id)):
            if rule.inclusive:
                # The price already contains every inclusive rate: extract this one's share.
                amount = round_minor(Decimal(base) * rule.rate / (1 + inclusive_rate))
                tax_included += amount
            else:
                amount = round_minor(Decimal(base) * rule.rate)
                tax += amount
                line_tax = [a + b for a, b in zip(line_tax, allocate(amount, taxable), strict=True)]
            tax_lines.append(TaxLine(rule.id, rule.name, rule.rate, amount, rule.inclusive))

    priced = [
        PricedLine(
            id=line.id,
            unit_price=line.unit_price,
            quantity=line.quantity,
            subtotal=line.subtotal,
            discount=line_discounts[i],
            tax=line_tax[i],
            total=line.subtotal - line_discounts[i] + line_tax[i],
        )
        for i, line in enumerate(lines)
    ]
    total = merchandise + (shipping or 0) + (tax or 0)
    return PricingResult(
        currency=data.currency,
        lines=priced,
        subtotal=subtotal,
        discount=discount_total,
        discounts=applied_discounts,
        rejected=rejected,
        shipping=shipping,
        shipping_before_discount=shipping_before,
        shipping_option=shipping_option,
        shipping_options=fitting,
        tax=tax,
        tax_included=tax_included,
        tax_lines=tax_lines,
        total=total,
        item_count=sum(line.quantity for line in lines),
    )
