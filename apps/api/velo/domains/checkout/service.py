"""Checkout — from a cart to a payment intent (PAYMENTS-AND-CHECKOUT.md §2 and §3).

The rules this module exists to keep:

1. **The client never states a price.** Every total is computed by the cart's
   pricing engine from the database: at creation, at each step, and once more
   under the discount locks immediately before the provider is called. The
   amount sent to the provider is that figure — nothing from a request.
2. **Stock is reserved, not merely checked.** Creating a checkout reserves every
   line in the same transaction (inventory/service.py), or fails with 409.
3. **Every transition is validated** against the table in ``state.py``.
4. **A payment is written before the provider is called**, so a crash mid-call
   leaves a record for reconciliation instead of an untraceable charge.

**What a checkout prices.** Its lines are fixed when it is created — the cart's
variants and quantities, stored in ``snapshot["items"]``. Prices, discounts,
shipping and tax are recomputed from the catalog each time; the latest result
is ``snapshot["lines"]`` and the totals columns. Changing the cart during
checkout does not change the checkout; starting a new checkout does, and
retires the old one.

**Who may touch a checkout.** Whoever created it: the signed-in owner, or the
browser holding its token. The token is an HMAC of the session id under the
server's secret — nothing is stored, and a replayed creation response can set
the same cookie again. Anyone else gets 404, not 403 (API-SPEC.md §1).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from velo.core.errors import ConflictError, NotFoundError, ValidationError
from velo.core.logging import get_logger
from velo.core.pagination import MoneyJson
from velo.db.ids import uuid7
from velo.domains.cart.service import CartOwner, CartService, Quote, QuoteItem
from velo.domains.cart.views import AppliedDiscountView, CartWarning
from velo.domains.checkout.exceptions import (
    AddressUnserviceableError,
    CartEmptyError,
    CheckoutExpiredError,
    DiscountExpiredError,
    PriceChangedError,
    ShippingRateError,
)
from velo.domains.checkout.repository import CheckoutRepository, SessionRecord
from velo.domains.checkout.state import EDITABLE, OPEN, Status, transition
from velo.domains.checkout.views import (
    AddressOut,
    CheckoutLineView,
    CheckoutTotals,
    CheckoutView,
    PaymentIntentView,
    PaymentStateView,
    ShippingMethodView,
    ShippingRatesView,
)
from velo.domains.discounts.service import DiscountService
from velo.domains.identity.addresses import AddressService
from velo.domains.identity.repository import AddressRecord
from velo.domains.inventory.service import InventoryService
from velo.domains.orders.service import OrderService
from velo.domains.payments.exceptions import PaymentsUnavailableError
from velo.domains.payments.provider import ProviderError
from velo.domains.payments.registry import PaymentProviders
from velo.domains.payments.service import PaymentService
from velo.domains.shipping.service import Address

logger = get_logger(__name__)

# A checkout may retire these when the same cart starts a new one.
_RETIRABLE = (
    Status.INITIATED.value,
    Status.ADDRESS_SET.value,
    Status.SHIPPING_SET.value,
    Status.FAILED.value,
)
_ADDRESS_FIELDS = (
    "first_name",
    "last_name",
    "company",
    "line1",
    "line2",
    "city",
    "region",
    "postal_code",
    "country_code",
    "phone",
)
# Warnings a checkout does not show: its own reservation is the stock it would
# otherwise say is short, and an unshippable address is refused outright.
_HIDDEN_WARNINGS = {"insufficient_stock", "no_shipping"}


def checkout_token(secret: str, session_id: uuid.UUID) -> str:
    digest = hmac.new(secret.encode(), b"checkout:" + session_id.bytes, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


@dataclass(frozen=True, slots=True)
class CheckoutAccess:
    """Whoever is asking: a signed-in user, and the checkout cookie their browser holds."""

    user_id: uuid.UUID | None = None
    token: str | None = None


def _money(amount: int, currency: str) -> MoneyJson:
    return MoneyJson(amount=amount, currency=currency)


def normalise_address(fields: dict[str, Any]) -> dict[str, Any]:
    """Trimmed, collapsed whitespace; country, region code and postcode upper-cased."""
    clean: dict[str, Any] = {}
    for key in _ADDRESS_FIELDS:
        value = fields.get(key)
        if isinstance(value, str):
            value = " ".join(value.split()) or None
        clean[key] = value
    clean["country_code"] = str(clean["country_code"]).upper()
    if clean["postal_code"]:
        clean["postal_code"] = str(clean["postal_code"]).upper()
    region = clean["region"]
    if region and len(region) <= 3:
        clean["region"] = region.upper()  # 'ca' → 'CA'; a full name keeps its case
    return clean


def _address_json(address: AddressRecord) -> dict[str, Any]:
    return {key: getattr(address, key) for key in _ADDRESS_FIELDS}


# ── The snapshot ──────────────────────────────────────────────────────────────


def _snapshot(items: list[QuoteItem], quote: Quote, code: str | None) -> dict[str, Any]:
    """Everything the totals were computed from, as JSON (see the module docstring)."""
    result = quote.result
    priced = {line.id: line for line in result.lines}
    lines: list[dict[str, Any]] = []
    for item, variant, _ in quote.lines:
        line = priced.get(item.id)
        if line is None or variant is None:
            continue  # not purchasable now: not charged, not ordered
        rate = (
            sum((tax.rate for tax in result.tax_lines), Decimal(0))
            if variant.is_taxable
            else Decimal(0)
        )
        lines.append(
            {
                "item_id": str(item.id),
                "variant_id": str(item.variant_id),
                "product_title": variant.product_title,
                "variant_title": variant.variant_title,
                "sku": variant.sku,
                "image_url": variant.image_url,
                "requires_shipping": variant.requires_shipping,
                "unit_price": line.unit_price,
                "quantity": line.quantity,
                "subtotal": line.subtotal,
                "discount": line.discount,
                "tax": line.tax,
                "total": line.total,
                "tax_rate": str(rate.quantize(Decimal("0.0001"))),
            }
        )
    option = result.shipping_option
    coded = (code or "").casefold()
    return {
        "items": [
            {"item_id": str(i.id), "variant_id": str(i.variant_id), "quantity": i.quantity}
            for i in items
        ],
        "lines": lines,
        "code": code,
        "code_applied": bool(coded)
        and any((d.code or "").casefold() == coded for d in result.discounts),
        "discounts": [
            {
                "id": str(d.id),
                "code": d.code,
                "title": d.title,
                "type": d.type,
                "amount": d.amount,
            }
            for d in result.discounts
        ],
        # A payment in flight holds one redemption of each (discounts/service.py).
        "discount_ids": [str(d.id) for d in result.discounts],
        "shipping": (
            {
                "id": str(option.id),
                "name": option.name,
                "price": result.shipping,
                "est_days_min": option.est_days_min,
                "est_days_max": option.est_days_max,
            }
            if option is not None and result.shipping is not None
            else None
        ),
        "tax_included": result.tax_included,
        "tax_lines": [
            {"name": t.name, "rate": str(t.rate), "amount": t.amount, "inclusive": t.inclusive}
            for t in result.tax_lines
        ],
        "warnings": [
            w.model_dump(mode="json") for w in quote.warnings if w.code not in _HIDDEN_WARNINGS
        ],
    }


def _totals(quote: Quote) -> dict[str, int]:
    result = quote.result
    return {
        "subtotal_amount": result.subtotal,
        "discount_amount": result.discount,
        "shipping_amount": result.shipping or 0,
        "tax_amount": result.tax or 0,
        "total_amount": result.total,
    }


def _fingerprint(snapshot: dict[str, Any], total: int) -> tuple[Any, ...]:
    """What the customer agreed to: the lines at their prices, the discounts, the total."""
    return (
        total,
        tuple(
            (line["variant_id"], line["quantity"], line["unit_price"]) for line in snapshot["lines"]
        ),
        tuple(sorted(snapshot["discount_ids"])),
        (snapshot.get("shipping") or {}).get("price"),
    )


def _quantities(snapshot: dict[str, Any], key: str = "lines") -> dict[uuid.UUID, int]:
    quantities: dict[uuid.UUID, int] = {}
    for line in snapshot[key]:
        variant_id = uuid.UUID(line["variant_id"])
        quantities[variant_id] = quantities.get(variant_id, 0) + int(line["quantity"])
    return quantities


def _requires_shipping(snapshot: dict[str, Any]) -> bool:
    return any(line.get("requires_shipping", True) for line in snapshot["lines"])


class CheckoutService:
    def __init__(
        self,
        session: AsyncSession,
        *,
        cart: CartService,
        inventory: InventoryService,
        discounts: DiscountService,
        addresses: AddressService,
        payments: PaymentService,
        orders: OrderService,
        providers: PaymentProviders,
        secret: str,
        ttl: timedelta = timedelta(minutes=30),
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._session = session
        self._checkouts = CheckoutRepository(session)
        self._cart = cart
        self._inventory = inventory
        self._discounts = discounts
        self._addresses = addresses
        self._payments = payments
        self._orders = orders
        self._providers = providers
        self._secret = secret
        self._ttl = ttl
        self._clock = clock

    def token_for(self, session_id: uuid.UUID) -> str:
        return checkout_token(self._secret, session_id)

    # ── Create ────────────────────────────────────────────────────────────

    async def create(self, owner: CartOwner, email: str) -> CheckoutView:
        """Snapshot the priced cart and reserve its stock, in one transaction."""
        cart = await self._cart.checkout_cart(owner)  # locked: one checkout at a time per cart
        if cart is None or not cart.items:
            raise CartEmptyError("Your cart is empty.")
        now = self._clock()
        session_id = uuid7()

        for previous in await self._checkouts.for_cart(cart.id, _RETIRABLE):
            await self._close(previous, Status.ABANDONED)

        quote = await self._cart.quote(
            cart.items,
            currency=cart.currency,
            code=cart.discount_code,
            user_id=cart.user_id,
            email=email,
            checkout_id=session_id,
        )
        snapshot = _snapshot(cart.items, quote, cart.discount_code)
        if not snapshot["lines"]:
            raise CartEmptyError("Nothing in your cart can be bought right now.")
        expires_at = now + self._ttl
        record = await self._checkouts.create(
            session_id,
            cart_id=cart.id,
            user_id=cart.user_id,
            email=email.strip().lower(),
            status=Status.INITIATED.value,
            currency=cart.currency,
            discount_id=self._coded_discount(snapshot),
            snapshot=snapshot,
            expires_at=expires_at,
            **_totals(quote),
        )
        # Only purchasable lines are reserved, and only they will be ordered. If
        # any is short, OutOfStockError rolls the whole checkout back.
        await self._inventory.reserve(session_id, _quantities(snapshot), expires_at)
        await self._session.commit()
        logger.info("checkout_created", checkout=str(session_id), lines=len(snapshot["lines"]))
        return await self._view(record)

    # ── Read ──────────────────────────────────────────────────────────────

    async def get(self, session_id: uuid.UUID, access: CheckoutAccess) -> CheckoutView:
        record = await self._owned(session_id, access)
        if self._due(record):
            record = await self._expire(record.id) or record
        return await self._view(record)

    async def shipping_rates(
        self, session_id: uuid.UUID, access: CheckoutAccess
    ) -> ShippingRatesView:
        record = await self._owned(session_id, access)
        if record.shipping_address_id is None:
            raise ConflictError("Add a shipping address first.")
        quote = await self._requote(record, await self._address(record), record.shipping_rate_id)
        result = quote.result
        return ShippingRatesView(
            options=[
                ShippingMethodView(
                    id=option.id,
                    name=option.name,
                    price=_money(option.price, record.currency),
                    est_days_min=option.est_days_min,
                    est_days_max=option.est_days_max,
                )
                for option in result.shipping_options
            ],
            selected_id=result.shipping_option.id if result.shipping_option else None,
        )

    # ── Steps ─────────────────────────────────────────────────────────────

    async def set_address(
        self,
        session_id: uuid.UUID,
        access: CheckoutAccess,
        shipping: dict[str, Any],
        billing: dict[str, Any] | None,
    ) -> CheckoutView:
        record = await self._locked(session_id, access)
        status = transition(record.status, Status.ADDRESS_SET)
        ship = normalise_address(shipping)
        destination = Address(
            country_code=ship["country_code"],
            region=ship["region"],
            postal_code=ship["postal_code"],
        )
        # The first rate that fits is preselected; the customer confirms or changes it.
        quote = await self._requote(record, destination, None)
        snapshot = _snapshot(self._items(record), quote, record.snapshot["code"])
        if _requires_shipping(snapshot) and quote.result.shipping is None:
            raise AddressUnserviceableError()
        shipping_address = await self._addresses.create_for_checkout(ship)
        billing_address = (
            await self._addresses.create_for_checkout(normalise_address(billing))
            if billing is not None
            else shipping_address
        )
        record = await self._checkouts.update(
            record.id,
            status=status.value,
            shipping_address_id=shipping_address.id,
            billing_address_id=billing_address.id,
            shipping_rate_id=None,
            discount_id=self._coded_discount(snapshot),
            snapshot=snapshot,
            **_totals(quote),
        )
        await self._session.commit()
        return await self._view(record)

    async def set_shipping(
        self, session_id: uuid.UUID, access: CheckoutAccess, rate_id: uuid.UUID | None
    ) -> CheckoutView:
        record = await self._locked(session_id, access)
        status = transition(record.status, Status.SHIPPING_SET)
        quote = await self._requote(record, await self._address(record), rate_id)
        snapshot = _snapshot(self._items(record), quote, record.snapshot["code"])
        chosen = quote.result.shipping_option
        if _requires_shipping(snapshot):
            if rate_id is None or chosen is None or chosen.id != rate_id:
                raise ShippingRateError("That shipping method is not available for this order.")
        else:
            rate_id = None
        record = await self._checkouts.update(
            record.id,
            status=status.value,
            shipping_rate_id=rate_id,
            discount_id=self._coded_discount(snapshot),
            snapshot=snapshot,
            **_totals(quote),
        )
        await self._session.commit()
        return await self._view(record)

    async def abandon(self, session_id: uuid.UUID, access: CheckoutAccess) -> CheckoutView:
        """Release the stock early. Not once payment has started: that settles by itself."""
        record = await self._locked(session_id, access)
        record = await self._close(record, Status.ABANDONED)
        await self._session.commit()
        return await self._view(record)

    # ── Payment ───────────────────────────────────────────────────────────

    async def start_payment(
        self, session_id: uuid.UUID, access: CheckoutAccess
    ) -> PaymentIntentView:
        """Recompute the total from the database, record the payment, create the intent."""
        record = await self._locked(session_id, access)
        if record.status == Status.PAYMENT_PENDING:
            return await self._resume_payment(record)
        status = transition(record.status, Status.PAYMENT_PENDING)

        # The authoritative figure. Discount rows are locked first, so payments
        # racing for a limited code count one another's holds.
        await self._discounts.lock(sorted(uuid.UUID(i) for i in record.snapshot["discount_ids"]))
        quote = await self._requote(record, await self._address(record), record.shipping_rate_id)
        snapshot = _snapshot(self._items(record), quote, record.snapshot["code"])
        totals = _totals(quote)
        if _fingerprint(snapshot, totals["total_amount"]) != _fingerprint(
            record.snapshot, record.total_amount
        ):
            code_lost = record.snapshot["code_applied"] and not snapshot["code_applied"]
            await self._checkouts.update(
                record.id,
                discount_id=self._coded_discount(snapshot),
                snapshot=snapshot,
                **totals,
            )
            await self._session.commit()
            logger.info("checkout_repriced_at_payment", checkout=str(record.id))
            if code_lost:
                raise DiscountExpiredError(
                    "That code expired while you were checking out. Your total has been updated."
                )
            raise PriceChangedError(
                "Prices have changed since you last saw them. Review the new total, then pay."
            )
        if not snapshot["lines"]:
            raise CartEmptyError("Nothing in this checkout can be bought any more.")
        if record.total_amount <= 0:
            raise ValidationError("An order with nothing to pay cannot be placed yet.")

        provider = self._providers.for_currency(record.currency)  # 503 before anything is written
        payment = await self._payments.create_pending(
            session_id=record.id,
            provider=provider.name,
            amount=record.total_amount,
            currency=record.currency,
        )
        # Time to complete 3-D Secure: the reservation lives as long as the attempt.
        expires_at = self._clock() + self._ttl
        await self._inventory.extend(record.id, expires_at)
        record = await self._checkouts.update(record.id, status=status.value, expires_at=expires_at)
        await self._session.commit()  # the payment exists before the provider hears of it

        try:
            intent = await provider.create_intent(
                amount=payment.amount,
                currency=payment.currency,
                idempotency_key=f"velo-payment-{payment.id}",
                metadata={"payment_id": str(payment.id), "checkout_session_id": str(record.id)},
                email=record.email,
            )
        except ProviderError as exc:
            logger.warning("payment_intent_failed", provider=provider.name, error=str(exc)[:200])
            await self._payments.update(
                payment.id,
                status="failed",
                failure_code="provider_unavailable",
                failure_message=str(exc)[:500],
            )
            locked = await self._checkouts.get(record.id, lock=True)
            if locked is not None and locked.status == Status.PAYMENT_PENDING:
                await self._checkouts.update(
                    record.id, status=transition(locked.status, Status.FAILED).value
                )
            await self._session.commit()
            raise PaymentsUnavailableError(
                "Payments are temporarily unavailable. Please try again in a few minutes."
            ) from exc
        await self._payments.attach_intent(payment.id, intent)
        await self._session.commit()
        logger.info("payment_intent_created", payment=str(payment.id), provider=provider.name)
        return PaymentIntentView(
            payment_id=payment.id,
            provider=provider.name,
            client_secret=intent.client_secret or "",
            publishable_key=provider.publishable_key,
            amount=_money(payment.amount, payment.currency),
            expires_at=record.expires_at,
        )

    async def _resume_payment(self, record: SessionRecord) -> PaymentIntentView:
        """The payment step reloaded: hand back the intent already in flight."""
        payment = await self._payments.latest_for_session(record.id)
        if (
            payment is None
            or payment.provider_intent_id is None
            or payment.status
            not in (
                "pending",
                "requires_action",
            )
        ):
            raise ConflictError("A payment for this checkout is already being processed.")
        await self._session.commit()  # release the lock before calling out
        provider = self._providers.get(payment.provider)
        try:
            intent = await provider.get_intent(payment.provider_intent_id)
        except ProviderError as exc:
            raise PaymentsUnavailableError(
                "Payments are temporarily unavailable. Please try again in a few minutes."
            ) from exc
        return PaymentIntentView(
            payment_id=payment.id,
            provider=provider.name,
            client_secret=intent.client_secret or "",
            publishable_key=provider.publishable_key,
            amount=_money(payment.amount, payment.currency),
            expires_at=record.expires_at,
        )

    # ── Internals ─────────────────────────────────────────────────────────

    async def _owned(
        self, session_id: uuid.UUID, access: CheckoutAccess, *, lock: bool = False
    ) -> SessionRecord:
        record = await self._checkouts.get(session_id, lock=lock)
        if record is None or not self._may_access(record, access):
            raise NotFoundError("No such checkout.")
        return record

    def _may_access(self, record: SessionRecord, access: CheckoutAccess) -> bool:
        if access.user_id is not None and record.user_id == access.user_id:
            return True
        return bool(access.token) and hmac.compare_digest(
            access.token or "", self.token_for(record.id)
        )

    async def _locked(self, session_id: uuid.UUID, access: CheckoutAccess) -> SessionRecord:
        """The session, locked for a change — or 410 if its time is up."""
        record = await self._owned(session_id, access, lock=True)
        if self._due(record):
            await self._close(record, Status.EXPIRED)
            await self._session.commit()
            raise CheckoutExpiredError("Your checkout timed out. Your cart is saved.")
        if record.status == Status.EXPIRED:
            raise CheckoutExpiredError("Your checkout timed out. Your cart is saved.")
        return record

    def _due(self, record: SessionRecord) -> bool:
        """Past its time, and not waiting on a payment (reconciliation settles those)."""
        return (
            record.status in EDITABLE or record.status == Status.FAILED
        ) and record.expires_at <= self._clock()

    async def _expire(self, session_id: uuid.UUID) -> SessionRecord | None:
        record = await self._checkouts.get(session_id, lock=True)
        if record is None or not self._due(record):
            await self._session.rollback()
            return record
        record = await self._close(record, Status.EXPIRED)
        await self._session.commit()
        return record

    async def _close(self, record: SessionRecord, target: Status) -> SessionRecord:
        """End a checkout that is still holding stock, and give the stock back."""
        status = transition(record.status, target)
        if record.status in OPEN:
            await self._inventory.release(
                record.id, status="expired" if target is Status.EXPIRED else "released"
            )
        logger.info("checkout_closed", checkout=str(record.id), status=status.value)
        return await self._checkouts.update(record.id, status=status.value)

    def _items(self, record: SessionRecord) -> list[QuoteItem]:
        return [
            QuoteItem(
                id=uuid.UUID(item["item_id"]),
                variant_id=uuid.UUID(item["variant_id"]),
                quantity=int(item["quantity"]),
            )
            for item in record.snapshot["items"]
        ]

    async def _requote(
        self, record: SessionRecord, address: Address | None, rate_id: uuid.UUID | None
    ) -> Quote:
        return await self._cart.quote(
            self._items(record),
            currency=record.currency,
            code=record.snapshot["code"],
            address=address,
            shipping_rate_id=rate_id,
            user_id=record.user_id,
            email=record.email,
            checkout_id=record.id,
        )

    async def _address(self, record: SessionRecord) -> Address | None:
        if record.shipping_address_id is None:
            return None
        found = await self._addresses.by_id(record.shipping_address_id)
        if found is None:  # pragma: no cover — checkout addresses are never deleted
            return None
        return Address(
            country_code=found.country_code, region=found.region, postal_code=found.postal_code
        )

    @staticmethod
    def _coded_discount(snapshot: dict[str, Any]) -> uuid.UUID | None:
        code = (snapshot.get("code") or "").casefold()
        for discount in snapshot["discounts"]:
            if code and (discount["code"] or "").casefold() == code:
                return uuid.UUID(discount["id"])
        return None

    async def _view(self, record: SessionRecord) -> CheckoutView:
        snapshot, currency = record.snapshot, record.currency
        has_address = record.shipping_address_id is not None
        shipping_address = (
            await self._addresses.by_id(record.shipping_address_id)
            if record.shipping_address_id
            else None
        )
        billing_address = (
            await self._addresses.by_id(record.billing_address_id)
            if record.billing_address_id
            else None
        )
        payment = await self._payments.latest_for_session(record.id)
        order = (
            await self._orders.by_checkout(record.id) if record.status == Status.CONFIRMED else None
        )
        shipping = snapshot.get("shipping") if has_address else None
        return CheckoutView(
            id=record.id,
            status=record.status,
            email=record.email,
            currency=currency,
            items=[
                CheckoutLineView(
                    variant_id=uuid.UUID(line["variant_id"]),
                    sku=line["sku"],
                    product_title=line["product_title"],
                    variant_title=line["variant_title"],
                    image_url=line["image_url"],
                    quantity=line["quantity"],
                    unit_price=_money(line["unit_price"], currency),
                    line_total=_money(line["subtotal"], currency),
                    line_discount=_money(line["discount"], currency),
                )
                for line in snapshot["lines"]
            ],
            discounts=[
                AppliedDiscountView(
                    code=d["code"],
                    title=d["title"],
                    type=d["type"],
                    amount=_money(d["amount"], currency),
                )
                for d in snapshot["discounts"]
            ],
            totals=CheckoutTotals(
                subtotal=_money(record.subtotal_amount, currency),
                discount=_money(record.discount_amount, currency),
                shipping=_money(record.shipping_amount, currency) if has_address else None,
                tax=_money(record.tax_amount, currency) if has_address else None,
                tax_included=(
                    _money(snapshot["tax_included"], currency)
                    if has_address and snapshot.get("tax_included")
                    else None
                ),
                total=_money(record.total_amount, currency),
            ),
            shipping_address=AddressOut(**_address_json(shipping_address))
            if shipping_address
            else None,
            billing_address=AddressOut(**_address_json(billing_address))
            if billing_address
            else None,
            shipping_method=(
                ShippingMethodView(
                    id=uuid.UUID(shipping["id"]),
                    name=shipping["name"],
                    price=_money(shipping["price"], currency),
                    est_days_min=shipping["est_days_min"],
                    est_days_max=shipping["est_days_max"],
                )
                if shipping
                else None
            ),
            expires_at=record.expires_at,
            warnings=[CartWarning(**warning) for warning in snapshot.get("warnings", [])],
            payment=(
                PaymentStateView(status=payment.status, failure_message=payment.failure_message)
                if payment
                else None
            ),
            order_number=order.order_number if order else None,
        )
