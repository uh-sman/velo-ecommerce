"""Settlement — acting on what the provider says happened to a payment.

Called by the webhook processor and by reconciliation, never by a browser
(ADR-010). Every method runs inside the caller's transaction, with the payment
row already locked (``FOR UPDATE``) — which also serialises two events for
the same intent (PAYMENTS-AND-CHECKOUT.md §6.3). The caller commits.

**It is a state machine over the payment, not a sequence of steps.** Events
arrive in any order and any number of times:

- ``succeeded`` is final. A ``failed``, ``cancelled`` or progress event for a
  payment that already succeeded is logged and ignored.
- ``succeeded`` after ``failed`` is normal — a declined card, then a good one on
  the same intent — and creates the order.
- ``succeeded`` for a payment we cancelled still creates the order: a provider
  that cannot cancel (Paystack) may take the money anyway, and money taken
  means an order is owed.

**Creating the order** (:meth:`Settlement.succeeded`) is one transaction: the
reservation becomes a sale, the order and its lines are inserted from the
checkout's snapshot, discounts are redeemed, the payment is marked, the
checkout confirmed, the cart cleared of what was bought, and ``order.created``
goes to the outbox. ``orders.checkout_session_id`` is unique, so however many
times this runs for a checkout, there is one order.
"""

from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from velo.core.logging import get_logger
from velo.db.ids import uuid7
from velo.domains.cart.service import CartService
from velo.domains.checkout.repository import CheckoutRepository, SessionRecord
from velo.domains.checkout.state import OPEN, Status, transition
from velo.domains.discounts.service import DiscountService
from velo.domains.identity.addresses import AddressService
from velo.domains.inventory.service import InventoryService
from velo.domains.orders.repository import OrderRecord
from velo.domains.orders.service import OrderDraft, OrderLineDraft, OrderService
from velo.domains.payments.provider import PaymentIntent, WebhookEvent
from velo.domains.payments.repository import PaymentRecord
from velo.domains.payments.service import PaymentService
from velo.domains.platform.events import record_event

logger = get_logger(__name__)

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


class SettleLaterError(Exception):
    """The event is real but cannot be applied yet — retry it later."""


class Settlement:
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
    ) -> None:
        self._session = session
        self._checkouts = CheckoutRepository(session)
        self._cart = cart
        self._inventory = inventory
        self._discounts = discounts
        self._addresses = addresses
        self._payments = payments
        self._orders = orders

    # ── Money moved ───────────────────────────────────────────────────────

    async def succeeded(
        self, payment: PaymentRecord, intent: PaymentIntent, *, actor_type: str = "webhook"
    ) -> OrderRecord:
        """The customer paid. Make sure exactly one order exists for their checkout."""
        received = intent.amount_received or intent.amount
        captured = min(received, payment.amount)
        if payment.status == "succeeded" and payment.order_id is not None:
            existing = await self._orders.get(payment.order_id)
            if existing is not None:
                return existing  # a replay: already settled

        record = await self._checkouts.get(payment.checkout_session_id, lock=True)
        if record is None:  # pragma: no cover — the foreign key forbids it
            raise SettleLaterError(f"checkout {payment.checkout_session_id} not found")
        if payment.status in ("cancelled", "failed"):
            logger.warning(
                "payment_succeeded_after_" + payment.status,
                payment=str(payment.id),
                checkout=str(record.id),
            )

        existing = await self._orders.by_checkout(record.id)
        if existing is not None:
            if payment.status == "succeeded":
                return existing  # this duplicate was already recorded and alerted
            # Two payments succeeded for one checkout: the customer was charged
            # twice. The order stands; the second payment needs a refund.
            await self._payments.apply_intent(
                payment.id, intent, "succeeded", amount_captured=captured
            )
            record_event(
                self._session,
                "payment",
                payment.id,
                "payment.duplicate",
                {
                    "order_number": existing.order_number,
                    "amount": captured,
                    "currency": payment.currency,
                    "provider": payment.provider,
                    "intent": intent.id,
                },
            )
            logger.error("payment_duplicate", payment=str(payment.id), order=existing.order_number)
            return existing

        order_id = uuid7()
        snapshot = record.snapshot
        quantities = self._quantities(snapshot)
        shortfalls = await self._inventory.commit_sale(record.id, quantities, order_id)

        attention: dict[str, Any] = {}
        if shortfalls:
            attention["stock_shortfall"] = [
                {"variant_id": str(s.variant_id), "ordered": s.requested, "taken": s.available}
                for s in shortfalls
            ]
        if received != record.total_amount or intent.currency not in ("", record.currency):
            attention["amount_mismatch"] = {
                "expected": record.total_amount,
                "received": received,
                "currency": intent.currency or payment.currency,
            }

        order = await self._orders.place(
            order_id,
            OrderDraft(
                user_id=record.user_id,
                email=record.email,
                checkout_session_id=record.id,
                currency=record.currency,
                subtotal=record.subtotal_amount,
                discount=record.discount_amount,
                shipping=record.shipping_amount,
                tax=record.tax_amount,
                total=record.total_amount,
                shipping_address=await self._address_json(record.shipping_address_id),
                billing_address=await self._address_json(record.billing_address_id),
                discount_code=snapshot.get("code") if snapshot.get("code_applied") else None,
                lines=[
                    OrderLineDraft(
                        variant_id=uuid.UUID(line["variant_id"]),
                        product_title=line["product_title"],
                        variant_title=line["variant_title"],
                        sku=line["sku"],
                        image_url=line["image_url"],
                        unit_price=int(line["unit_price"]),
                        quantity=int(line["quantity"]),
                        discount=int(line["discount"]),
                        tax_rate=Decimal(line["tax_rate"]),
                        tax=int(line["tax"]),
                        total=int(line["total"]),
                    )
                    for line in snapshot["lines"]
                ],
                metadata={
                    "shipping_method": snapshot.get("shipping"),
                    "discounts": snapshot.get("discounts", []),
                    "tax_lines": snapshot.get("tax_lines", []),
                    **({"attention": attention} if attention else {}),
                },
            ),
            actor_type=actor_type,
        )
        await self._discounts.redeem(
            [(uuid.UUID(d["id"]), int(d["amount"])) for d in snapshot.get("discounts", [])],
            order_id=order.id,
            user_id=record.user_id,
        )
        await self._payments.apply_intent(
            payment.id, intent, "succeeded", order_id=order.id, amount_captured=captured
        )
        await self._checkouts.update(
            record.id, status=transition(record.status, Status.CONFIRMED).value
        )
        await self._cart.consume(
            record.cart_id, quantities, code_used=bool(snapshot.get("code_applied"))
        )
        if attention:
            record_event(
                self._session,
                "order",
                order.id,
                "order.needs_attention",
                {"order_number": order.order_number, **attention},
            )
            logger.error("order_needs_attention", order=order.order_number, **attention)
        logger.info(
            "order_created",
            order=order.order_number,
            checkout=str(record.id),
            payment=str(payment.id),
            actor=actor_type,
        )
        return order

    async def failed(self, payment: PaymentRecord, intent: PaymentIntent) -> None:
        """Declined. The checkout keeps its stock until it expires; the customer may retry."""
        if payment.status == "succeeded":
            self._out_of_order(payment, "failed")
            return
        already_told = payment.status == "failed"  # one email per decline, not per event
        await self._payments.apply_intent(payment.id, intent, "failed")
        record = await self._checkouts.get(payment.checkout_session_id, lock=True)
        if record is None:  # pragma: no cover
            return
        if record.status == Status.PAYMENT_PENDING and await self._is_current(record, payment):
            await self._checkouts.update(
                record.id, status=transition(record.status, Status.FAILED).value
            )
        if not already_told:
            record_event(
                self._session,
                "checkout",
                record.id,
                "payment.failed",
                {"email": record.email, "reason": intent.failure_message or intent.failure_code},
            )

    async def cancelled(self, payment: PaymentRecord, intent: PaymentIntent) -> None:
        """The intent will never be paid. End the checkout and return its stock."""
        if payment.status == "succeeded":
            self._out_of_order(payment, "cancelled")
            return
        await self._payments.apply_intent(payment.id, intent, "cancelled")
        record = await self._checkouts.get(payment.checkout_session_id, lock=True)
        if record is None:  # pragma: no cover
            return
        if record.status in (Status.PAYMENT_PENDING, Status.FAILED) and await self._is_current(
            record, payment
        ):
            if record.status in OPEN:
                await self._inventory.release(record.id, status="released")
            await self._checkouts.update(
                record.id, status=transition(record.status, Status.EXPIRED).value
            )

    async def progressed(self, payment: PaymentRecord, intent: PaymentIntent, status: str) -> None:
        """``processing`` or ``requires_action``: bookkeeping only."""
        if payment.status in ("succeeded", "cancelled"):
            self._out_of_order(payment, status)
            return
        await self._payments.apply_intent(payment.id, intent, status)

    # ── After the sale ────────────────────────────────────────────────────

    async def refunded(self, payment: PaymentRecord, event: WebhookEvent) -> None:
        """Bring the payment and order's refunded amounts up to the provider's figure."""
        if payment.order_id is None:
            raise SettleLaterError("refund reported before the order exists")
        if event.refund is not None:
            added = await self._payments.add_refund(
                payment_id=payment.id,
                order_id=payment.order_id,
                provider_refund_id=event.refund.id or None,
                amount=event.refund.amount,
                currency=payment.currency,
                reason="other",
                status="succeeded" if event.refund.status == "succeeded" else "pending",
                note="Reported by the provider",
            )
            if not added and event.refund.id:
                # One of ours (orders/refunds.py): the provider confirms how it ended.
                await self._payments.settle_refund(event.refund.id, event.refund.status)
        total = (
            event.amount_refunded
            if event.amount_refunded is not None
            else await self._payments.refunded_total(payment.id)
        )
        total = min(total, payment.amount_captured)
        if total <= payment.amount_refunded:
            return  # nothing new
        if event.refund is None:
            # Refunds we issued and are waiting on explain the new money first;
            # only what they do not cover was issued outside our tools.
            unexplained = await self._payments.absorb_pending_refunds(
                payment.id, total - payment.amount_refunded
            )
            if unexplained > 0:
                # The provider's dashboard: record it all the same.
                await self._payments.add_refund(
                    payment_id=payment.id,
                    order_id=payment.order_id,
                    provider_refund_id=None,
                    amount=unexplained,
                    currency=payment.currency,
                    reason="other",
                    status="succeeded",
                    note="Issued at the provider",
                )
        await self._payments.update(payment.id, amount_refunded=total)
        await self._orders.record_refunded(
            payment.order_id, total, payload={"provider_event": event.id}
        )

    async def disputed(self, payment: PaymentRecord, event: WebhookEvent, *, opened: bool) -> None:
        if payment.order_id is None:
            raise SettleLaterError("dispute reported before the order exists")
        dispute = event.dispute
        await self._orders.record_dispute(
            payment.order_id,
            {
                "id": dispute.id if dispute else None,
                "amount": dispute.amount if dispute else None,
                "reason": dispute.reason if dispute else None,
                "status": dispute.status if dispute else None,
            },
            opened=opened,
        )

    # ── Helpers ───────────────────────────────────────────────────────────

    async def _is_current(self, record: SessionRecord, payment: PaymentRecord) -> bool:
        """Only the checkout's latest attempt moves its state; older ones are history."""
        latest = await self._payments.latest_for_session(record.id)
        return latest is None or latest.id == payment.id

    @staticmethod
    def _quantities(snapshot: dict[str, Any]) -> dict[uuid.UUID, int]:
        quantities: dict[uuid.UUID, int] = {}
        for line in snapshot["lines"]:
            variant_id = uuid.UUID(line["variant_id"])
            quantities[variant_id] = quantities.get(variant_id, 0) + int(line["quantity"])
        return quantities

    async def _address_json(self, address_id: uuid.UUID | None) -> dict[str, Any]:
        if address_id is None:
            return {}
        address = await self._addresses.by_id(address_id)
        if address is None:  # pragma: no cover
            return {}
        return {key: getattr(address, key) for key in _ADDRESS_FIELDS}

    @staticmethod
    def _out_of_order(payment: PaymentRecord, incoming: str) -> None:
        logger.warning(
            "webhook_out_of_order",
            payment=str(payment.id),
            current=payment.status,
            incoming=incoming,
        )
