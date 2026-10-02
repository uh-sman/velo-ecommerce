"""The background half of payments: webhook processing, reconciliation, the sweeper.

**Webhook processing** (PAYMENTS-AND-CHECKOUT.md §6). The router stored the
verified event and answered 200; :class:`PaymentEventProcessor` applies it.
Each attempt is one transaction: the event row and the payment row are
locked, settlement runs, and the event is marked processed — together, or
not at all. A failed attempt is counted and retried with exponential backoff;
the fifth failure dead-letters it, raises an alert, and waits for a person
(``python -m velo.scripts.payment_events``). Nothing is dropped silently.

**Reconciliation** (§7) — the safety net for lost webhooks. Every 15 minutes,
:class:`Reconciler` asks the provider about each payment still unsettled after
30 minutes, and settles it the way the webhook would have: *succeeded with no
order* runs the full order-creation path. Intents the customer never finished
are cancelled at the provider once their checkout's time is up, so they can no
longer be paid; declined intents on checkouts that have ended likewise.

**The sweeper** expires checkouts whose time is up — ones not waiting on a
payment — and returns their stock. A checkout waiting on a payment is left to
reconciliation, which knows whether the money moved.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from velo.core.config import Settings
from velo.core.logging import get_logger
from velo.domains.cart.service import CartService
from velo.domains.catalog.cache import CatalogCache
from velo.domains.catalog.service import CatalogService
from velo.domains.checkout.repository import CheckoutRepository
from velo.domains.checkout.settlement import SettleLaterError, Settlement
from velo.domains.checkout.state import Status, transition
from velo.domains.discounts.service import DiscountService
from velo.domains.identity.addresses import AddressService
from velo.domains.inventory.service import InventoryService
from velo.domains.orders.service import OrderService
from velo.domains.payments.provider import (
    EventKind,
    IntentStatus,
    PaymentIntent,
    PaymentProvider,
    ProviderError,
    WebhookEvent,
)
from velo.domains.payments.registry import PaymentProviders
from velo.domains.payments.repository import UNSETTLED, PaymentRecord
from velo.domains.payments.service import PaymentService
from velo.domains.platform.events import record_event
from velo.domains.shipping.service import RulesTaxProvider, ShippingService

logger = get_logger(__name__)

Clock = Callable[[], datetime]
STUCK_PROCESSING = timedelta(hours=24)


def _now() -> datetime:
    return datetime.now(UTC)


def build_settlement(session: AsyncSession, settings: Settings, cache: CatalogCache) -> Settlement:
    """Settlement and everything it needs, for code that has a session and no request."""
    inventory = InventoryService(session, display_threshold=settings.stock_display_threshold)
    discounts = DiscountService(session)
    return Settlement(
        session,
        cart=CartService(
            session,
            catalog=CatalogService(session, cache, inventory),
            inventory=inventory,
            discounts=discounts,
            shipping=ShippingService(session),
            tax=RulesTaxProvider(session),
            currency=settings.currency,
        ),
        inventory=inventory,
        discounts=discounts,
        addresses=AddressService(session),
        payments=PaymentService(session),
        orders=OrderService(session),
    )


# ── Webhook events ────────────────────────────────────────────────────────────


class PaymentEventProcessor:
    def __init__(
        self,
        session: AsyncSession,
        *,
        providers: PaymentProviders,
        settlement: Settlement,
        clock: Clock = _now,
    ) -> None:
        self._session = session
        self._providers = providers
        self._settlement = settlement
        self._payments = PaymentService(session)
        self._clock = clock

    async def process(self, event_id: uuid.UUID) -> str:
        """Apply one stored event. Returns processed, done, busy, retrying or dead_lettered."""
        event = await self._payments.claim_event(event_id)
        if event is None:
            await self._session.rollback()
            return "busy"  # another worker holds it
        if event.processed_at is not None or event.dead_lettered_at is not None:
            await self._session.rollback()
            return "done"
        try:
            provider = self._providers.get(event.provider)
            payment_id = await self._apply(provider, provider.parse_event(event.payload))
            await self._payments.mark_processed(event.id, payment_id)
            await self._session.commit()
        except Exception as exc:
            await self._session.rollback()
            return await self._failed(event_id, exc)
        logger.info(
            "payment_event_processed", provider_event=event.provider_event_id, type=event.event_type
        )
        return "processed"

    async def _apply(self, provider: PaymentProvider, event: WebhookEvent) -> uuid.UUID | None:
        if event.kind is EventKind.OTHER:
            return None
        payment = await self._payments.find(
            provider.name, event.intent_id, event.payment_ref, lock=True
        )
        if payment is None:
            # Our payment row commits before the provider is called, so an
            # event for an unknown intent is either not ours or not visible
            # yet. Retrying costs little; dropping a payment could cost an order.
            raise SettleLaterError(f"no payment for intent {event.intent_id}")

        match event.kind:
            case EventKind.PAYMENT_SUCCEEDED:
                await self._settlement.succeeded(
                    payment, await self._truth(provider, event, payment)
                )
            case EventKind.PAYMENT_FAILED:
                await self._settlement.failed(payment, self._intent(event, payment))
            case EventKind.PAYMENT_CANCELLED:
                await self._settlement.cancelled(payment, self._intent(event, payment))
            case EventKind.PAYMENT_PROCESSING:
                await self._settlement.progressed(
                    payment, self._intent(event, payment), "processing"
                )
            case EventKind.PAYMENT_REQUIRES_ACTION:
                await self._settlement.progressed(
                    payment, self._intent(event, payment), "requires_action"
                )
            case EventKind.CHARGE_REFUNDED:
                await self._settlement.refunded(payment, event)
            case EventKind.DISPUTE_CREATED:
                await self._settlement.disputed(payment, event, opened=True)
            case EventKind.DISPUTE_CLOSED:
                await self._settlement.disputed(payment, event, opened=False)
        return payment.id

    @staticmethod
    def _intent(event: WebhookEvent, payment: PaymentRecord) -> PaymentIntent:
        if event.intent is not None:
            return event.intent
        return PaymentIntent(
            id=event.intent_id or payment.provider_intent_id or "",
            status=IntentStatus.PROCESSING,
            amount=payment.amount,
            currency=payment.currency,
        )

    async def _truth(
        self, provider: PaymentProvider, event: WebhookEvent, payment: PaymentRecord
    ) -> PaymentIntent:
        """For a success: the provider's current view, which carries the card details.

        The signed event is authoritative on its own, so a provider that cannot
        be reached right now does not hold up the order.
        """
        intent_id = event.intent_id or payment.provider_intent_id
        if intent_id:
            try:
                current = await provider.get_intent(intent_id)
            except ProviderError as exc:
                logger.warning("payment_intent_lookup_failed", error=str(exc)[:200])
            else:
                if current.status is IntentStatus.SUCCEEDED:
                    return current
        return self._intent(event, payment)

    async def _failed(self, event_id: uuid.UUID, exc: Exception) -> str:
        error = f"{type(exc).__name__}: {exc}"
        event = await self._payments.event(event_id)
        if event is None:  # pragma: no cover
            return "gone"
        dead = await self._payments.mark_event_failed(event, error, self._clock())
        if dead:
            record_event(
                self._session,
                "payment_event",
                event.id,
                "payment_event.dead_lettered",
                {
                    "provider": event.provider,
                    "provider_event_id": event.provider_event_id,
                    "event_type": event.event_type,
                    "error": error[:500],
                },
            )
            logger.error(
                "payment_event_dead_lettered",
                provider_event=event.provider_event_id,
                type=event.event_type,
                error=error[:500],
            )
        else:
            logger.warning(
                "payment_event_failed",
                provider_event=event.provider_event_id,
                attempt=event.attempts + 1,
                error=error[:500],
            )
        await self._session.commit()
        return "dead_lettered" if dead else "retrying"

    async def process_due(self, limit: int = 100) -> dict[str, int]:
        """Every event whose next attempt is due — the retry loop, and the net under the queue."""
        counts: dict[str, int] = {}
        for event_id in await self._payments.due_events(self._clock(), limit):
            await self._session.rollback()
            outcome = await self.process(event_id)
            counts[outcome] = counts.get(outcome, 0) + 1
        return counts


# ── Reconciliation ────────────────────────────────────────────────────────────


class Reconciler:
    def __init__(
        self,
        session: AsyncSession,
        *,
        providers: PaymentProviders,
        settlement: Settlement,
        after: timedelta = timedelta(minutes=30),
        clock: Clock = _now,
    ) -> None:
        self._session = session
        self._providers = providers
        self._settlement = settlement
        self._payments = PaymentService(session)
        self._checkouts = CheckoutRepository(session)
        self._after = after
        self._clock = clock

    async def run(self) -> dict[str, int]:
        cutoff = self._clock() - self._after
        counts: dict[str, int] = {}
        stranded = await self._payments.unsettled_before(cutoff)
        declined = await self._payments.failed_on_closed_checkouts(cutoff)
        await self._session.rollback()
        for payment_id, reconcile in [
            *((p, self.reconcile) for p in stranded),
            *((p, self.cancel_declined) for p in declined),
        ]:
            try:
                outcome = await reconcile(payment_id)
            except Exception:
                await self._session.rollback()
                logger.exception("reconcile_failed", payment=str(payment_id))
                outcome = "error"
            counts[outcome] = counts.get(outcome, 0) + 1
        if counts:
            logger.info("payments_reconciled", **counts)
        return counts

    async def reconcile(self, payment_id: uuid.UUID) -> str:
        """Settle one payment from the provider's own record of it."""
        payment = await self._payments.get(payment_id, lock=True)
        if payment is None or payment.status not in UNSETTLED:
            await self._session.rollback()
            return "already_settled"
        if payment.provider_intent_id is None:
            # The provider was never reached, or its answer was lost before the
            # browser had a client secret. Without one, nobody could have paid.
            await self._settlement.cancelled(
                payment,
                PaymentIntent(
                    id="",
                    status=IntentStatus.CANCELLED,
                    amount=payment.amount,
                    currency=payment.currency,
                    failure_code="no_intent",
                ),
            )
            await self._session.commit()
            return "cancelled"

        provider = self._providers.get(payment.provider)
        intent = await provider.get_intent(payment.provider_intent_id)
        outcome = await self._settle(provider, payment, intent)
        await self._session.commit()
        return outcome

    async def _settle(
        self, provider: PaymentProvider, payment: PaymentRecord, intent: PaymentIntent
    ) -> str:
        match intent.status:
            case IntentStatus.SUCCEEDED:
                had_order = payment.order_id is not None
                await self._settlement.succeeded(payment, intent, actor_type="system")
                if not had_order:
                    logger.warning("order_recovered_by_reconciliation", payment=str(payment.id))
                return "recovered"
            case IntentStatus.FAILED:
                await self._settlement.failed(payment, intent)
                return "failed"
            case IntentStatus.CANCELLED:
                await self._settlement.cancelled(payment, intent)
                return "cancelled"
            case IntentStatus.PROCESSING:
                if payment.created_at < self._clock() - STUCK_PROCESSING:
                    record_event(
                        self._session,
                        "payment",
                        payment.id,
                        "payment.stuck",
                        {"provider": payment.provider, "intent": intent.id},
                    )
                    logger.error("payment_stuck_processing", payment=str(payment.id))
                    return "stuck"
                await self._settlement.progressed(payment, intent, "processing")
                return "processing"
            case _:  # the customer has not finished paying
                checkout = await self._checkouts.get(payment.checkout_session_id)
                if checkout is not None and checkout.expires_at > self._clock():
                    return "waiting"
                cancelled = await provider.cancel(
                    intent.id, idempotency_key=f"velo-cancel-{payment.id}"
                )
                if cancelled.status is IntentStatus.SUCCEEDED:  # paid at the last moment
                    await self._settlement.succeeded(payment, cancelled, actor_type="system")
                    return "recovered"
                await self._settlement.cancelled(payment, cancelled)
                return "cancelled"

    async def cancel_declined(self, payment_id: uuid.UUID) -> str:
        """A declined intent on a checkout that has ended: make sure it cannot be paid now."""
        payment = await self._payments.get(payment_id, lock=True)
        if payment is None or payment.status != "failed" or not payment.provider_intent_id:
            await self._session.rollback()
            return "already_settled"
        provider = self._providers.get(payment.provider)
        try:
            intent = await provider.cancel(
                payment.provider_intent_id, idempotency_key=f"velo-cancel-{payment.id}"
            )
        except ProviderError:
            intent = await provider.get_intent(payment.provider_intent_id)
        if intent.status is IntentStatus.SUCCEEDED:
            await self._settlement.succeeded(payment, intent, actor_type="system")
            outcome = "recovered"
        else:
            await self._payments.apply_intent(payment.id, intent, "cancelled")
            outcome = "cancelled"
        await self._session.commit()
        return outcome


# ── Sweeper ───────────────────────────────────────────────────────────────────


class CheckoutSweeper:
    _SWEEPABLE = (
        Status.INITIATED.value,
        Status.ADDRESS_SET.value,
        Status.SHIPPING_SET.value,
        Status.FAILED.value,
    )

    def __init__(
        self, session: AsyncSession, inventory: InventoryService, clock: Clock = _now
    ) -> None:
        self._session = session
        self._checkouts = CheckoutRepository(session)
        self._inventory = inventory
        self._payments = PaymentService(session)
        self._clock = clock

    async def sweep(self, limit: int = 500) -> dict[str, int]:
        now = self._clock()
        expired = 0
        for session_id in await self._checkouts.expired(now, self._SWEEPABLE, limit):
            record = await self._checkouts.get(session_id, lock=True)
            if record is None or record.status not in self._SWEEPABLE or record.expires_at > now:
                await self._session.rollback()
                continue
            await self._inventory.release(record.id, status="expired")
            await self._checkouts.update(
                record.id, status=transition(record.status, Status.EXPIRED).value
            )
            await self._session.commit()  # one checkout per transaction: short locks
            expired += 1
        keys = await self._payments.delete_expired_keys()
        await self._session.commit()
        if expired or keys:
            logger.info("checkouts_swept", expired=expired, idempotency_keys=keys)
        return {"expired": expired, "idempotency_keys": keys}
