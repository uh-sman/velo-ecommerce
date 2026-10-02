"""Refunds — PAYMENTS-AND-CHECKOUT.md §8.

    validate against the capture ledger ─► insert refund (pending) ─► commit
        ─► call the provider, keyed by the refund's id ─► record the answer

**The ceiling.** A refund may never take the payment past what was captured.
It is checked with the payment row locked, against succeeded *and* pending
refunds — so two operators refunding at the same moment serialise on the
lock, and the second sees the first. ``CHECK (amount_refunded <=
amount_captured)`` is the backstop.

**Lines.** A refund names order lines and units; each unit is worth its
cumulative share of the line's total (rules.line_share), so refunding a line
in parts never loses or invents a cent. Shipping and goodwill amounts ride on
top. A unit refunded *with restock* before it shipped comes off the order:
its stock goes back, and it will not be fulfilled.

**After commit.** The provider is called only once the refund row is safely
stored. A crash before the call leaves a pending, unsubmitted refund, which
reconciliation submits later under the same idempotency key — the refund's
own id. Paystack takes no idempotency key, so a Paystack refund whose first
attempt has an unknown outcome is escalated to a person, never retried blind.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from velo.core.errors import FieldError, NotFoundError
from velo.core.logging import get_logger
from velo.domains.inventory.service import InventoryService
from velo.domains.orders.exceptions import (
    NothingToRefundError,
    QuantityExceededError,
    RefundExceedsCaptureError,
)
from velo.domains.orders.repository import OrderItemRecord, OrderRecord, OrderRepository
from velo.domains.orders.rules import line_share, refundable, shipping_share
from velo.domains.orders.service import OrderService
from velo.domains.payments.exceptions import PaymentsUnavailableError
from velo.domains.payments.provider import ProviderError, RefundReason
from velo.domains.payments.registry import PaymentProviders
from velo.domains.payments.repository import PaymentRepository, RefundRecord
from velo.domains.platform.events import Actor, record_audit, record_event

logger = get_logger(__name__)

# Providers that honour an idempotency key on refunds: safe to retry blind.
IDEMPOTENT_REFUNDS = frozenset({"stripe"})
_ESCALATED = "unknown outcome; escalated"


@dataclass(frozen=True, slots=True)
class RefundLine:
    order_item_id: uuid.UUID
    quantity: int
    restock: bool = False


@dataclass(frozen=True, slots=True)
class RefundRequest:
    lines: list[RefundLine] = field(default_factory=list)
    include_shipping: bool = False
    extra_amount: int = 0  # goodwill, in minor units
    reason: str = "requested_by_customer"
    note: str | None = None


@dataclass(frozen=True, slots=True)
class _Planned:
    lines: list[tuple[uuid.UUID, int, int, bool]]  # item, units, amount, restock
    amount: int


class RefundService:
    def __init__(
        self,
        session: AsyncSession,
        providers: PaymentProviders,
        inventory: InventoryService | None = None,
    ) -> None:
        self._session = session
        self._providers = providers
        self._orders = OrderRepository(session)
        self._order_service = OrderService(session)
        self._payments = PaymentRepository(session)
        self._inventory = inventory or InventoryService(session)

    # ── Issuing ───────────────────────────────────────────────────────────

    async def issue(
        self,
        order_id: uuid.UUID,
        request: RefundRequest,
        actor: Actor,
        *,
        actor_type: str = "staff",
        return_id: uuid.UUID | None = None,
        cap_to_ceiling: bool = False,
        restock: bool = True,
    ) -> RefundRecord:
        """Validate and record a pending refund, in the caller's transaction. No commit.

        ``cap_to_ceiling``: refund what is left rather than refusing (cancellation).
        ``restock``: return stock for lines marked restock (off when the caller has).
        """
        order = await self._orders.get(order_id, lock=True)
        if order is None:
            raise NotFoundError("No such order.")
        payment = await self._payments.settled_payment_for_order(order.id, lock=True)
        if payment is None or payment.provider_intent_id is None:
            raise NothingToRefundError("This order has no captured payment to refund.")

        items = {item.id: item for item in await self._orders.items(order.id, lock=True)}
        plan = await self._plan(order, items, request)
        ceiling = refundable(
            payment.amount_captured, await self._payments.committed_refund_total(payment.id)
        )
        amount = min(plan.amount, ceiling) if cap_to_ceiling else plan.amount
        if amount <= 0:
            raise NothingToRefundError("There is nothing left to refund on this order.")
        if amount > ceiling:
            raise RefundExceedsCaptureError(
                f"Only {ceiling} (minor units) is left to refund on this payment.",
                errors=[
                    FieldError(
                        field="amount",
                        code="exceeds_capture",
                        message=f"At most {ceiling} can still be refunded.",
                    )
                ],
            )
        lines = plan.lines
        if amount < plan.amount:
            # Capped: keep the unit bookkeeping, scale nothing — the lines say
            # what is being given back, the amount says how much money moved.
            lines = [(item_id, units, 0, keep) for item_id, units, _, keep in plan.lines]

        refund = await self._payments.create_refund(
            lines,
            payment_id=payment.id,
            order_id=order.id,
            return_id=return_id,
            amount=amount,
            currency=payment.currency,
            reason=request.reason,
            status="pending",
            actor_id=actor.user_id,
            note=request.note,
        )
        if restock:
            back: dict[uuid.UUID, int] = {}
            for item_id, units, _, keep in lines:
                variant_id = items[item_id].variant_id
                if keep and variant_id is not None:
                    back[variant_id] = back.get(variant_id, 0) + units
            if back:
                await self._inventory.return_to_stock(
                    back,
                    reference_type="order",
                    reference_id=order.id,
                    actor_id=actor.user_id,
                    note=f"Refund {refund.id}",
                )
        await self._orders.add_event(
            order.id,
            event_type="refund_requested",
            from_status=None,
            to_status=None,
            actor_type=actor_type,
            actor_id=actor.user_id,
            payload={
                "refund_id": str(refund.id),
                "amount": amount,
                "reason": request.reason,
                "lines": [
                    {"order_item_id": str(i), "quantity": u, "restock": k} for i, u, _, k in lines
                ],
                **({"note": request.note} if request.note else {}),
            },
        )
        if actor_type == "staff":
            record_audit(
                self._session,
                actor,
                "order.refund_requested",
                "order",
                order.id,
                {"amount": amount, "reason": request.reason, "refund_id": str(refund.id)},
            )
        return refund

    async def _plan(
        self, order: OrderRecord, items: dict[uuid.UUID, OrderItemRecord], request: RefundRequest
    ) -> _Planned:
        refunded = await self._payments.refunded_units(order.id)
        lines: list[tuple[uuid.UUID, int, int, bool]] = []
        seen: set[uuid.UUID] = set()
        for line in request.lines:
            item = items.get(line.order_item_id)
            if item is None or line.order_item_id in seen:
                raise QuantityExceededError(
                    "Each line may appear once, and must belong to this order.",
                    errors=[
                        FieldError(
                            field=f"lines.{line.order_item_id}",
                            code="unknown_line",
                            message="Not a line of this order.",
                        )
                    ],
                )
            seen.add(item.id)
            done, removed = refunded.get(item.id, (0, 0))
            left = item.quantity - done
            if line.quantity < 1 or line.quantity > left:
                raise QuantityExceededError(
                    f"{item.sku}: {left} left to refund.",
                    errors=[
                        FieldError(
                            field=f"lines.{item.id}",
                            code="too_many",
                            message=f"{left} of this line can still be refunded.",
                        )
                    ],
                )
            if line.restock:
                unshipped = item.quantity - item.quantity_fulfilled - removed
                if line.quantity > unshipped:
                    raise QuantityExceededError(
                        f"{item.sku}: only {unshipped} unshipped; shipped units come back "
                        "through a return.",
                        errors=[
                            FieldError(
                                field=f"lines.{item.id}",
                                code="restock_shipped",
                                message=f"Only {unshipped} unshipped units can be restocked.",
                            )
                        ],
                    )
            amount = line_share(item.total_amount, item.quantity, done, line.quantity)
            lines.append((item.id, line.quantity, amount, line.restock))

        total = sum(amount for _, _, amount, _ in lines) + max(0, request.extra_amount)
        if request.include_shipping:
            shipping = shipping_share(order.total_amount, (i.total_amount for i in items.values()))
            # Shipping not already given back by an earlier refund.
            total += max(0, shipping - await self._payments.extra_refunded(order.id))
        return _Planned(lines=lines, amount=total)

    async def issue_and_submit(
        self, order_id: uuid.UUID, request: RefundRequest, actor: Actor
    ) -> RefundRecord:
        """Record, commit, then send to the provider: the staff refund endpoint's whole job."""
        refund = await self.issue(order_id, request, actor)
        await self._session.commit()
        submitted = await self.submit(refund.id)
        return submitted or refund

    # ── Submitting ────────────────────────────────────────────────────────

    async def submit(self, refund_id: uuid.UUID) -> RefundRecord | None:
        """Send a stored refund to the provider and record the answer. Commits."""
        refund = await self._payments.refund(refund_id, lock=True)
        if refund is None or refund.status != "pending" or refund.submitted_at is not None:
            await self._session.commit()
            return refund
        payment = await self._payments.get(refund.payment_id)
        if payment is None or payment.provider_intent_id is None:  # pragma: no cover
            await self._session.commit()
            return refund
        if refund.attempts > 0 and payment.provider not in IDEMPOTENT_REFUNDS:
            # An earlier attempt's outcome is unknown and the provider cannot
            # deduplicate: a person checks the provider's dashboard. Once.
            if refund.last_error == _ESCALATED:
                await self._session.commit()
                return refund
            record_event(
                self._session,
                "order",
                refund.order_id,
                "refund.needs_attention",
                {
                    "refund_id": str(refund.id),
                    "provider": payment.provider,
                    "amount": refund.amount,
                },
            )
            await self._payments.update_refund(refund.id, last_error=_ESCALATED)
            await self._session.commit()
            return refund
        try:
            provider = self._providers.get(payment.provider)
        except PaymentsUnavailableError:
            await self._payments.update_refund(refund.id, last_error="provider not configured")
            await self._session.commit()
            return refund

        # Count the attempt before calling out, so a crash mid-call is visible.
        await self._payments.update_refund(refund.id, attempts=refund.attempts + 1)
        await self._session.commit()

        try:
            result = await provider.refund(
                intent_id=payment.provider_intent_id,
                amount=refund.amount,
                reason=_reason(refund.reason),
                idempotency_key=str(refund.id),
            )
        except ProviderError as exc:
            await self._payments.refund(refund.id, lock=True)
            if exc.retryable:
                # Nothing reached the provider, or it failed there: submit again later.
                await self._payments.update_refund(refund.id, last_error=str(exc)[:500])
            else:
                await self._payments.update_refund(
                    refund.id,
                    status="failed",
                    submitted_at=_now(),
                    last_error=str(exc)[:500],
                )
                record_event(
                    self._session,
                    "order",
                    refund.order_id,
                    "refund.needs_attention",
                    {"refund_id": str(refund.id), "error": str(exc)[:200]},
                )
            logger.warning(
                "refund_submit_failed", refund_id=str(refund.id), retryable=exc.retryable
            )
            await self._session.commit()
            return await self._payments.refund(refund.id)

        await self._payments.refund(refund.id, lock=True)
        await self._payments.update_refund(
            refund.id,
            provider_refund_id=result.id or None,
            submitted_at=_now(),
            status=result.status if result.status in ("succeeded", "failed") else "pending",
            last_error=None,
        )
        if result.status == "succeeded":
            await self.apply_succeeded(refund.payment_id, refund.order_id, refund.actor_id)
        await self._session.commit()
        return await self._payments.refund(refund.id)

    async def apply_succeeded(
        self, payment_id: uuid.UUID, order_id: uuid.UUID, actor_id: uuid.UUID | None
    ) -> None:
        """Bring the payment and order up to the ledger's succeeded total."""
        payment = await self._payments.get(payment_id, lock=True)
        if payment is None:  # pragma: no cover
            return
        total = min(await self._payments.refunded_total(payment_id), payment.amount_captured)
        if total > payment.amount_refunded:
            await self._payments.update(payment_id, amount_refunded=total)
        await self._order_service.record_refunded(
            order_id,
            total,
            payload={"source": "refund"},
            actor_type="staff" if actor_id else "system",
            actor_id=actor_id,
        )

    # ── Reconciliation ────────────────────────────────────────────────────

    async def submit_stranded(
        self, *, older_than: timedelta = timedelta(minutes=2)
    ) -> dict[str, int]:
        """Submit refunds a crash or a provider outage left unsubmitted."""
        ids = await self._payments.unsubmitted_refunds(_now() - older_than, limit=100)
        await self._session.commit()
        submitted = 0
        for refund_id in ids:
            refund = await self.submit(refund_id)
            if refund is not None and refund.submitted_at is not None:
                submitted += 1
        return {"found": len(ids), "submitted": submitted}


def _reason(value: str) -> RefundReason:
    try:
        return RefundReason(value)
    except ValueError:
        return RefundReason.OTHER


def _now() -> datetime:
    return datetime.now(UTC)
