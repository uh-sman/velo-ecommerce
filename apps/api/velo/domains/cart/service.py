"""The cart: ownership, lines, merge on sign-in, and pricing on every read.

Rules:

- **A client sends a variant and a quantity — nothing else.** Every price comes
  from ``product_variants`` at the moment of reading, through the pricing
  engine. There is no request shape that carries a price (API-SPEC.md §2).
- **Re-priced on every read and every mutation.** Nothing is cached in the cart.
- **Never silently changed.** A product that disappears, a price that moves, or
  stock that falls short is reported as a warning; the line stays until the
  customer acts. An unavailable line is not charged.
- **Guest carts** are found by an opaque cookie token; only its SHA-256 hash is
  stored, so a database leak does not let anyone take over a cart.
- **Merge on sign-in** is deterministic: quantities of the same variant add up,
  capped at what can be sold and at 999; the signed-in cart's discount code
  wins over the guest's; lines keep the order they were added in.
- A mutation makes an abandoned cart active again and slides its expiry.
"""

from __future__ import annotations

import hashlib
import secrets
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from velo.core.errors import NotFoundError, ValidationError
from velo.core.logging import get_logger
from velo.core.pagination import MoneyJson
from velo.domains.cart.exceptions import (
    CurrencyMismatchError,
    DiscountCodeError,
    NotPurchasableError,
    QuantityUnavailableError,
)
from velo.domains.cart.pricing import Ineligible, Line, PricingInput, PricingResult, price_cart
from velo.domains.cart.repository import CartRecord, CartRepository, ItemRecord
from velo.domains.cart.views import (
    AppliedDiscountView,
    CartItemView,
    CartView,
    CartWarning,
    ItemAvailability,
    ShippingEstimate,
    ShippingOptionView,
    Totals,
    VariantRef,
)
from velo.domains.catalog.repository import VariantSnapshot
from velo.domains.catalog.service import CatalogService
from velo.domains.discounts.service import MESSAGES, DiscountService
from velo.domains.inventory.service import InventoryService
from velo.domains.shipping.service import Address, ShippingService, TaxProvider

logger = get_logger(__name__)

MAX_QUANTITY = 999  # per line; the database checks it too
CART_TTL = timedelta(days=30)

_CART_RULE_MESSAGES = {
    Ineligible.MIN_SUBTOTAL: "Your cart has not reached this code's minimum yet.",
    Ineligible.NO_TARGETS: "This code does not apply to anything in your cart.",
    Ineligible.NOT_ENOUGH_ITEMS: "Add more qualifying items to use this code.",
    Ineligible.CURRENCY: "This code cannot be used in this currency.",
    Ineligible.NOTHING_TO_SHIP: "Nothing in your cart ships, so free shipping does not apply.",
}


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


@dataclass(frozen=True, slots=True)
class CartOwner:
    """Whoever is asking: a signed-in user, or a browser holding a guest token."""

    user_id: uuid.UUID | None = None
    guest_token: str | None = None


@dataclass(frozen=True, slots=True)
class Estimate:
    """An address to estimate shipping and tax for, and a chosen rate."""

    address: Address | None = None
    shipping_rate_id: uuid.UUID | None = None


@dataclass(slots=True)
class CartResult:
    view: CartView
    new_guest_token: str | None = None  # set: the router sets the cookie
    clear_guest_cookie: bool = False


@dataclass(slots=True)
class _Priced:
    result: PricingResult
    lines: list[tuple[ItemRecord, VariantSnapshot | None, int]]  # item, snapshot, max quantity
    warnings: list[CartWarning] = field(default_factory=list)


def _money(amount: int, currency: str) -> MoneyJson:
    return MoneyJson(amount=amount, currency=currency)


class CartService:
    def __init__(
        self,
        session: AsyncSession,
        *,
        catalog: CatalogService,
        inventory: InventoryService,
        discounts: DiscountService,
        shipping: ShippingService,
        tax: TaxProvider,
        currency: str = "USD",
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._session = session
        self._carts = CartRepository(session)
        self._catalog = catalog
        self._inventory = inventory
        self._discounts = discounts
        self._shipping = shipping
        self._tax = tax
        self._currency = currency
        self._clock = clock

    # ── Finding the cart ──────────────────────────────────────────────────

    async def _find(self, owner: CartOwner, *, lock: bool = False) -> CartRecord | None:
        if owner.user_id is not None:
            return await self._carts.for_user(owner.user_id, lock=lock)
        if owner.guest_token:
            return await self._carts.for_token(hash_token(owner.guest_token), lock=lock)
        return None

    async def _find_or_create(self, owner: CartOwner) -> tuple[CartRecord, str | None]:
        cart = await self._find(owner, lock=True)
        if cart is not None:
            return cart, None
        if owner.user_id is not None:
            return await self._carts.create(
                user_id=owner.user_id, token_hash=None, currency=self._currency
            ), None
        token = secrets.token_urlsafe(32)
        cart = await self._carts.create(
            user_id=None, token_hash=hash_token(token), currency=self._currency
        )
        return cart, token

    # ── Reads ─────────────────────────────────────────────────────────────

    async def get(self, owner: CartOwner, estimate: Estimate | None = None) -> CartResult:
        cart = await self._find(owner)
        return CartResult(view=await self._view(cart, estimate or Estimate()))

    # ── Mutations ─────────────────────────────────────────────────────────

    async def add(
        self,
        owner: CartOwner,
        variant_id: uuid.UUID,
        quantity: int,
        estimate: Estimate | None = None,
    ) -> CartResult:
        cart, token = await self._find_or_create(owner)
        snapshot = await self._purchasable(variant_id, cart.currency)
        existing = next(
            (item for item in await self._carts.items(cart.id) if item.variant_id == variant_id),
            None,
        )
        wanted = quantity + (existing.quantity if existing else 0)
        await self._check_quantity(variant_id, wanted)
        await self._carts.put_item(cart.id, variant_id, wanted, snapshot.price_amount)
        return await self._commit(cart, token, estimate)

    async def set_quantity(
        self, owner: CartOwner, item_id: uuid.UUID, quantity: int, estimate: Estimate | None = None
    ) -> CartResult:
        cart = await self._find(owner, lock=True)
        item = await self._carts.item(cart.id, item_id) if cart else None
        if cart is None or item is None:
            raise NotFoundError("That item is not in your cart.")
        if quantity == 0:
            await self._carts.delete_item(cart.id, item_id)
        else:
            snapshot = await self._purchasable(item.variant_id, cart.currency)
            await self._check_quantity(item.variant_id, quantity)
            # Changing a line acknowledges its current price.
            await self._carts.put_item(cart.id, item.variant_id, quantity, snapshot.price_amount)
        return await self._commit(cart, None, estimate)

    async def remove(
        self, owner: CartOwner, item_id: uuid.UUID, estimate: Estimate | None = None
    ) -> CartResult:
        return await self.set_quantity(owner, item_id, 0, estimate)

    async def clear(self, owner: CartOwner, estimate: Estimate | None = None) -> CartResult:
        cart = await self._find(owner, lock=True)
        if cart is None:
            return CartResult(view=await self._view(None, estimate or Estimate()))
        await self._carts.clear(cart.id)
        await self._carts.set_code(cart.id, None)
        return await self._commit(cart, None, estimate)

    async def apply_code(
        self, owner: CartOwner, code: str, estimate: Estimate | None = None
    ) -> CartResult:
        code = code.strip()
        cart, token = await self._find_or_create(owner)
        customer = await self._discounts.customer(owner.user_id)
        candidates = await self._discounts.candidates(customer, code=code, now=self._clock())
        if candidates.code_problem is not None:
            raise DiscountCodeError(
                MESSAGES[candidates.code_problem], candidates.code_problem.value
            )
        # The code exists and this customer may use it: does it apply to this cart?
        coded = next(
            d for d in candidates.discounts if (d.code or "").casefold() == code.casefold()
        )
        priced = await self._price(
            cart.id, cart.currency, code, estimate or Estimate(), user_id=owner.user_id
        )
        reason = priced.result.rejected.get(coded.id)
        if reason is not None and reason is not Ineligible.OUTCLASSED:
            raise DiscountCodeError(_CART_RULE_MESSAGES[reason], reason.value)
        await self._carts.set_code(cart.id, coded.code)
        return await self._commit(cart, token, estimate)

    async def remove_code(self, owner: CartOwner, estimate: Estimate | None = None) -> CartResult:
        cart = await self._find(owner, lock=True)
        if cart is None:
            return CartResult(view=await self._view(None, estimate or Estimate()))
        await self._carts.set_code(cart.id, None)
        return await self._commit(cart, None, estimate)

    async def merge(
        self, guest_token: str | None, user_id: uuid.UUID, estimate: Estimate | None = None
    ) -> CartResult:
        """Fold the browser's guest cart into the user's. Idempotent: a second call is a no-op."""
        owner = CartOwner(user_id=user_id)
        guest = (
            await self._carts.for_token(hash_token(guest_token), lock=True) if guest_token else None
        )
        if guest is None:
            result = await self.get(owner, estimate)
            result.clear_guest_cookie = guest_token is not None
            return result
        user_cart = await self._carts.for_user(user_id, lock=True)
        notes: list[CartWarning] = []
        if user_cart is None:
            await self._carts.claim(guest.id, user_id)
            user_cart = guest
        else:
            notes = await self._fold(guest, user_cart)
            await self._carts.mark_merged(guest.id, user_id)
        result = await self._commit(user_cart, None, estimate, extra_warnings=notes)
        result.clear_guest_cookie = True
        logger.info("cart_merged", guest_cart=str(guest.id), cart=str(user_cart.id))
        return result

    async def _fold(self, guest: CartRecord, target: CartRecord) -> list[CartWarning]:
        guest_items = await self._carts.items(guest.id)
        target_items = {item.variant_id: item for item in await self._carts.items(target.id)}
        limits = await self._inventory.sellable_quantities(
            list({item.variant_id for item in guest_items})
        )
        notes: list[CartWarning] = []
        for item in guest_items:
            existing = target_items.get(item.variant_id)
            wanted = item.quantity + (existing.quantity if existing else 0)
            limit = limits.get(item.variant_id)
            ceiling = MAX_QUANTITY if limit is None else min(MAX_QUANTITY, limit)
            quantity = min(wanted, ceiling)
            if quantity < wanted:
                notes.append(
                    CartWarning(
                        code="quantity_reduced",
                        message=f"Only {ceiling} available: the quantity was reduced to fit.",
                    )
                )
            if quantity <= 0:
                continue
            seen = (existing.seen_price_amount if existing else None) or item.seen_price_amount
            await self._carts.put_item(target.id, item.variant_id, quantity, seen or 0)
        if target.discount_code is None and guest.discount_code is not None:
            await self._carts.set_code(target.id, guest.discount_code)
        return notes

    async def _purchasable(self, variant_id: uuid.UUID, currency: str) -> VariantSnapshot:
        snapshot = (await self._catalog.variant_snapshots([variant_id])).get(variant_id)
        if snapshot is None or not snapshot.purchasable:
            raise NotPurchasableError("That item is no longer available.")
        if snapshot.currency != currency:
            raise CurrencyMismatchError(
                f"That item is priced in {snapshot.currency}; your cart is in {currency}."
            )
        return snapshot

    async def _check_quantity(self, variant_id: uuid.UUID, quantity: int) -> None:
        if quantity > MAX_QUANTITY:
            raise ValidationError(f"At most {MAX_QUANTITY} of one item per order.")
        limit = (await self._inventory.sellable_quantities([variant_id]))[variant_id]
        if limit is not None and quantity > limit:
            raise QuantityUnavailableError(limit)

    async def _commit(
        self,
        cart: CartRecord,
        new_token: str | None,
        estimate: Estimate | None,
        *,
        extra_warnings: list[CartWarning] | None = None,
    ) -> CartResult:
        await self._carts.touch(cart.id, CART_TTL)
        await self._session.commit()
        refreshed = await self._carts.by_id(cart.id)  # the code or owner may have changed
        view = await self._view(refreshed, estimate or Estimate(), extra_warnings or [])
        return CartResult(view=view, new_guest_token=new_token)

    # ── Pricing and the view ──────────────────────────────────────────────

    async def _price(
        self,
        cart_id: uuid.UUID,
        currency: str,
        code: str | None,
        estimate: Estimate,
        *,
        user_id: uuid.UUID | None = None,
    ) -> _Priced:
        items = await self._carts.items(cart_id)
        variant_ids = [item.variant_id for item in items]
        snapshots = await self._catalog.variant_snapshots(variant_ids)
        limits = await self._inventory.sellable_quantities(variant_ids)

        lines: list[Line] = []
        rows: list[tuple[ItemRecord, VariantSnapshot | None, int]] = []
        warnings: list[CartWarning] = []
        for item in items:
            snapshot = snapshots.get(item.variant_id)
            limit = limits.get(item.variant_id)
            max_quantity = MAX_QUANTITY if limit is None else min(MAX_QUANTITY, limit)
            usable = snapshot is not None and snapshot.purchasable and snapshot.currency == currency
            rows.append((item, snapshot, max_quantity))
            if not usable or snapshot is None:
                warnings.append(
                    CartWarning(
                        code="unavailable",
                        message="This item is no longer available and will not be charged.",
                        item_id=item.id,
                    )
                )
                continue
            if (
                item.seen_price_amount is not None
                and item.seen_price_amount != snapshot.price_amount
            ):
                warnings.append(
                    CartWarning(
                        code="price_changed",
                        message="The price has changed since you added this.",
                        item_id=item.id,
                        previous_price=_money(item.seen_price_amount, currency),
                    )
                )
            if item.quantity > max_quantity:
                warnings.append(
                    CartWarning(
                        code="insufficient_stock",
                        message=(
                            "This is sold out."
                            if max_quantity == 0
                            else f"Only {max_quantity} available. Lower the quantity to check out."
                        ),
                        item_id=item.id,
                    )
                )
            lines.append(
                Line(
                    id=item.id,
                    product_id=snapshot.product_id,
                    unit_price=snapshot.price_amount,
                    quantity=item.quantity,
                    collection_ids=snapshot.collection_ids,
                    compare_at=snapshot.compare_at_amount,
                    weight_grams=snapshot.weight_grams,
                    taxable=snapshot.is_taxable,
                    requires_shipping=snapshot.requires_shipping,
                )
            )

        customer = await self._discounts.customer(user_id)
        candidates = await self._discounts.candidates(customer, code=code, now=self._clock())
        address = estimate.address
        result = price_cart(
            PricingInput(
                currency=currency,
                lines=lines,
                discounts=candidates.discounts,
                applied_code=code,
                shipping_options=(
                    await self._shipping.options_for(address, currency) if address else None
                ),
                selected_shipping_id=estimate.shipping_rate_id,
                tax_rules=await self._tax.rules_for(address) if address else None,
            )
        )
        if code:
            coded = next(
                (d for d in candidates.discounts if (d.code or "").casefold() == code.casefold()),
                None,
            )
            if candidates.code_problem is not None:
                warnings.append(
                    CartWarning(
                        code="discount_not_applied", message=MESSAGES[candidates.code_problem]
                    )
                )
            elif coded is not None and coded.id in result.rejected:
                reason = result.rejected[coded.id]
                warnings.append(
                    CartWarning(
                        code="discount_outclassed",
                        message="A better discount already applies to your cart.",
                    )
                    if reason is Ineligible.OUTCLASSED
                    else CartWarning(
                        code="discount_not_applied", message=_CART_RULE_MESSAGES[reason]
                    )
                )
        if (
            address is not None
            and result.shipping is None
            and any(line.requires_shipping for line in lines)
        ):
            warnings.append(
                CartWarning(
                    code="no_shipping", message="We do not ship these items to that address yet."
                )
            )
        return _Priced(result=result, lines=rows, warnings=warnings)

    async def _view(
        self,
        cart: CartRecord | None,
        estimate: Estimate,
        extra_warnings: list[CartWarning] | None = None,
    ) -> CartView:
        currency = cart.currency if cart else self._currency
        zero = _money(0, currency)
        if cart is None:
            return CartView(
                id=None,
                currency=currency,
                items=[],
                discount=None,
                discounts=[],
                discount_code=None,
                totals=Totals(
                    subtotal=zero,
                    discount=zero,
                    shipping=None,
                    tax=None,
                    tax_included=None,
                    total=zero,
                ),
                shipping=None,
                item_count=0,
                warnings=[],
            )
        priced = await self._price(
            cart.id, currency, cart.discount_code, estimate, user_id=cart.user_id
        )
        result = priced.result
        by_line = {line.id: line for line in result.lines}
        items = []
        for item, snapshot, max_quantity in priced.lines:
            line = by_line.get(item.id)
            price = snapshot.price_amount if snapshot else 0
            items.append(
                CartItemView(
                    id=item.id,
                    variant=VariantRef(
                        id=item.variant_id,
                        sku=snapshot.sku if snapshot else "",
                        product_title=snapshot.product_title if snapshot else "Unavailable item",
                        product_slug=snapshot.product_slug if snapshot else "",
                        variant_title=snapshot.variant_title if snapshot else "",
                        image_url=snapshot.image_url if snapshot else None,
                    ),
                    quantity=item.quantity,
                    unit_price=_money(price, currency),
                    compare_at=(
                        _money(snapshot.compare_at_amount, currency)
                        if snapshot and snapshot.compare_at_amount
                        else None
                    ),
                    line_total=_money(line.subtotal if line else 0, currency),
                    line_discount=_money(line.discount if line else 0, currency),
                    purchasable=line is not None,
                    availability=ItemAvailability(
                        in_stock=line is not None and max_quantity > 0,
                        max_quantity=max_quantity,
                    ),
                )
            )
        applied = [
            AppliedDiscountView(
                code=d.code, title=d.title, type=d.type, amount=_money(d.amount, currency)
            )
            for d in result.discounts
        ]
        code = (cart.discount_code or "").casefold()
        return CartView(
            id=cart.id,
            currency=currency,
            items=items,
            discount=next((d for d in applied if code and (d.code or "").casefold() == code), None),
            discounts=applied,
            discount_code=cart.discount_code,
            totals=Totals(
                subtotal=_money(result.subtotal, currency),
                discount=_money(result.discount, currency),
                shipping=_money(result.shipping, currency) if result.shipping is not None else None,
                tax=_money(result.tax, currency) if result.tax is not None else None,
                tax_included=(
                    _money(result.tax_included, currency) if result.tax_included else None
                ),
                total=_money(result.total, currency),
            ),
            shipping=(
                ShippingEstimate(
                    options=[
                        ShippingOptionView(
                            id=option.id,
                            name=option.name,
                            price=_money(option.price, currency),
                            est_days_min=option.est_days_min,
                            est_days_max=option.est_days_max,
                        )
                        for option in result.shipping_options
                    ],
                    selected_id=result.shipping_option.id if result.shipping_option else None,
                )
                if estimate.address is not None
                else None
            ),
            item_count=result.item_count,
            warnings=[*(extra_warnings or []), *priced.warnings],
        )


class CartSweeper:
    """Housekeeping for the worker: abandoned carts and expired guest carts."""

    def __init__(
        self, session: AsyncSession, clock: Callable[[], datetime] = lambda: datetime.now(UTC)
    ) -> None:
        self._session = session
        self._carts = CartRepository(session)
        self._clock = clock

    async def sweep(self, *, abandon_after: timedelta) -> dict[str, int]:
        """Mark idle carts abandoned; delete guest carts past their expiry."""
        abandoned = await self._carts.mark_abandoned(self._clock() - abandon_after)
        expired = await self._carts.delete_expired_guest_carts()
        await self._session.commit()
        return {"abandoned": abandoned, "expired": expired}
