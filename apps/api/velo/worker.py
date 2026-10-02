"""The background worker (ADR-009): ``uv run arq velo.worker.WorkerSettings``.

Jobs:

- ``relay_outbox`` — every 10 seconds, and at once when the API kicks it after
  a commit. Claims unpublished outbox events and acts on them: search-index
  updates, catalog cache invalidation, stock alerts, back-in-stock emails, and
  image processing.
- ``process_media`` — decode an uploaded image, write its renditions and
  blurhash (PLANNING.md 6.1).
- ``reindex_search`` — rebuild the search index from Postgres and swap it in.
- ``reconcile_search`` — hourly: find products the index is missing or should
  no longer have, and repair them.
- ``process_payment_event`` — apply one stored provider webhook, queued by the
  webhook route (PAYMENTS-AND-CHECKOUT.md §6). ``retry_payment_events`` runs
  every minute for retries and anything the queue lost.
- ``reconcile_payments`` — every 15 minutes: settle payments no webhook has
  settled, from the provider's own record (§7).
- ``sweep_checkouts`` — every minute: expire checkouts past their time and
  release their stock.
- ``reconcile_refunds`` — every 5 minutes: submit refunds a crash or a
  provider outage left recorded but unsent (orders/refunds.py).

Delivery is at least once. Every handler is idempotent: indexing upserts,
invalidation deletes, and a back-in-stock subscriber is marked notified in the
same transaction the email is sent from.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Iterable
from datetime import datetime, timedelta
from typing import Any

from arq import cron
from sqlalchemy.ext.asyncio import AsyncSession

import velo.db.models  # noqa: F401 — register every mapper; FKs cross domains
from velo.core.config import Settings, get_settings
from velo.core.email import Attachment, EmailMessage, Mailer, SmtpMailer
from velo.core.jobs import RELAY_JOB, redis_settings
from velo.core.logging import configure_logging, get_logger
from velo.core.meili import MeiliClient, SearchUnavailableError
from velo.core.storage import MediaStorage
from velo.db.redis import close_redis, get_redis, init_redis
from velo.db.session import dispose_engine, init_engine, open_session, session_scope
from velo.domains.cart.service import CartSweeper
from velo.domains.catalog.cache import CatalogCache
from velo.domains.catalog.images import InvalidImageError, process
from velo.domains.catalog.repository import CatalogRepository
from velo.domains.catalog.search import SearchIndexer
from velo.domains.checkout.processing import (
    CheckoutSweeper,
    PaymentEventProcessor,
    Reconciler,
    build_settlement,
)
from velo.domains.inventory.service import InventoryService
from velo.domains.orders.documents import invoice_pdf
from velo.domains.orders.refunds import RefundService
from velo.domains.orders.repository import OrderRepository
from velo.domains.orders.rules import order_token
from velo.domains.orders.service import OrderService
from velo.domains.payments.registry import PaymentProviders, build_providers
from velo.domains.platform.events import OutboxRepository, PendingEvent, record_event

logger = get_logger(__name__)

CLAIM_BATCH = 100
# Events whose only job is to keep the index and cache in step with a product.
_PRODUCT_EVENTS = {
    "product.created",
    "product.updated",
    "product.deleted",
    "inventory.changed",
    "media.processed",
}


class Worker:
    """Everything a job needs, built once per worker process."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.meili = MeiliClient(settings, timeout=10.0)
        self.storage = MediaStorage(settings)
        self.mailer: Mailer = SmtpMailer(settings)
        self.cache = CatalogCache(get_redis(), settings.catalog_cache_ttl_seconds)
        self.providers: PaymentProviders = build_providers(settings)

    def indexer(self, session: AsyncSession) -> SearchIndexer:
        return SearchIndexer(session, self.meili, self.settings.meilisearch_index)

    def event_processor(self, session: AsyncSession) -> PaymentEventProcessor:
        return PaymentEventProcessor(
            session,
            providers=self.providers,
            settlement=build_settlement(session, self.settings, self.cache),
        )

    def reconciler(self, session: AsyncSession) -> Reconciler:
        return Reconciler(
            session,
            providers=self.providers,
            settlement=build_settlement(session, self.settings, self.cache),
            after=timedelta(minutes=self.settings.payment_reconcile_after_minutes),
        )


def _worker(ctx: dict[str, Any]) -> Worker:
    worker: Worker = ctx["worker"]
    return worker


# ── The outbox relay ──────────────────────────────────────────────────────────


async def relay_outbox(ctx: dict[str, Any]) -> dict[str, int]:
    totals = {"published": 0, "failed": 0, "deferred": 0}
    while True:
        async with session_scope() as session:
            outbox = OutboxRepository(session)
            events = await outbox.claim(CLAIM_BATCH)
            if not events:
                break
            published, failed, deferred = await _dispatch(ctx, session, events)
            await outbox.mark_published(published)
            for event_id, error in failed:
                await outbox.mark_failed(event_id, error)
        totals["published"] += len(published)
        totals["failed"] += len(failed)
        totals["deferred"] += len(deferred)
        if len(events) < CLAIM_BATCH or len(published) + len(failed) == 0:
            break  # a full batch that was entirely deferred would spin; the cron retries
    if any(totals.values()):
        logger.info("outbox_relayed", **totals)
    return totals


async def _dispatch(
    ctx: dict[str, Any], session: AsyncSession, events: list[PendingEvent]
) -> tuple[list[uuid.UUID], list[tuple[uuid.UUID, str]], list[uuid.UUID]]:
    worker = _worker(ctx)
    published: list[uuid.UUID] = []
    failed: list[tuple[uuid.UUID, str]] = []
    deferred: list[uuid.UUID] = []

    # 1. Index and cache: one batch for every product touched by these events.
    product_events = [event for event in events if event.event_type in _PRODUCT_EVENTS]
    if product_events:
        product_ids = _unique(_product_id(event) for event in product_events)
        slugs = await _slugs_for(session, product_events, product_ids)
        await worker.cache.invalidate_product(*slugs)
        await worker.cache.bump()
        try:
            # Wait for Meilisearch to apply the change: an event is published
            # only once the index reflects it, so a failed task is retried.
            await worker.indexer(session).sync(product_ids, wait=True)
        except SearchUnavailableError as exc:
            # Not a failure of the events: leave them for the next run.
            logger.warning(
                "search_index_deferred", events=len(product_events), reason=str(exc)[:200]
            )
            deferred.extend(event.id for event in product_events)
        else:
            published.extend(event.id for event in product_events)

    # 2. Everything else, one event at a time.
    for event in events:
        if event.event_type in _PRODUCT_EVENTS:
            continue
        try:
            async with session.begin_nested():
                await _handle(ctx, session, event)
        except Exception as exc:
            logger.exception(
                "outbox_event_failed", event_type=event.event_type, event_id=str(event.id)
            )
            failed.append((event.id, f"{type(exc).__name__}: {exc}"))
        else:
            published.append(event.id)
    return published, failed, deferred


def _unique(values: Iterable[uuid.UUID]) -> list[uuid.UUID]:
    return list(dict.fromkeys(values))


def _product_id(event: PendingEvent) -> uuid.UUID:
    if event.aggregate_type == "product":
        return event.aggregate_id
    return uuid.UUID(event.payload["product_id"])


async def _slugs_for(
    session: AsyncSession, events: list[PendingEvent], product_ids: list[uuid.UUID]
) -> list[str]:
    """Every slug whose cached page may be stale: current ones, and old ones after a rename."""
    slugs = {
        value
        for event in events
        for key in ("slug", "old_slug")
        if isinstance(value := event.payload.get(key), str)
    }
    catalog = CatalogRepository(session)
    for product_id in product_ids:
        product = await catalog.product_by_id(product_id, include_deleted=True)
        if product is not None:
            slugs.add(product.slug)
    return sorted(slugs)


async def _handle(ctx: dict[str, Any], session: AsyncSession, event: PendingEvent) -> None:
    worker = _worker(ctx)
    match event.event_type:
        case "inventory.low_stock":
            await _low_stock_alert(worker, event)
        case "inventory.restocked":
            await _back_in_stock(worker, session, event.aggregate_id)
        case "media.uploaded":
            await ctx["redis"].enqueue_job("process_media", str(event.aggregate_id))
        case "media.deleted":
            await worker.storage.delete_prefix(event.payload["prefix"])
        case "order.created":
            await _order_confirmation(worker, session, event)
        case "payment.failed":
            await _payment_failed(worker, event)
        case "refund.issued":
            await _refund_issued(worker, event)
        case "order.shipped":
            await _order_shipped(worker, event)
        case "order.cancelled":
            await _order_cancelled(worker, event)
        case "return.requested" | "return.approved" | "return.rejected":
            await _return_update(worker, event)
        case (
            "order.needs_attention"
            | "order.dispute_opened"
            | "payment.duplicate"
            | "payment.stuck"
            | "payment_event.dead_lettered"
            | "refund.needs_attention"
        ):
            await _payments_alert(worker, event)
        case _:
            logger.info("outbox_event_ignored", event_type=event.event_type)


async def _low_stock_alert(worker: Worker, event: PendingEvent) -> None:
    payload = event.payload
    logger.warning(
        "low_stock",
        sku=payload.get("sku"),
        available=payload.get("available"),
        reorder_point=payload.get("reorder_point"),
    )
    if not worker.settings.ops_alert_email:
        return
    await worker.mailer.send(
        EmailMessage(
            to=worker.settings.ops_alert_email,
            subject=f"Low stock: {payload.get('sku')}",
            text=(
                f"{payload.get('product_title')} — {payload.get('variant_title')} "
                f"(SKU {payload.get('sku')}) is down to {payload.get('available')} available, "
                f"at or below its reorder point of {payload.get('reorder_point')}.\n\n"
                f"Restock it from the inventory screen of the admin dashboard."
            ),
        )
    )


async def _back_in_stock(worker: Worker, session: AsyncSession, variant_id: uuid.UUID) -> None:
    inventory = InventoryService(session)
    label, subscribers = await inventory.claim_subscribers(variant_id)
    if label is None or not subscribers:
        return
    link = f"{worker.settings.storefront_url}/products/{label.product_slug}"
    for subscriber in subscribers:
        await worker.mailer.send(
            EmailMessage(
                to=subscriber.email,
                subject=f"Back in stock: {label.product_title}",
                text=(
                    f"Good news — {label.product_title} ({label.variant_title}) is back in "
                    f"stock.\n\n{link}\n\nStock is limited, and we do not hold it for you. "
                    "You asked us to tell you once; we will not email about it again."
                ),
            )
        )
    await inventory.mark_notified([subscriber.id for subscriber in subscribers])
    logger.info("back_in_stock_notified", sku=label.sku, subscribers=len(subscribers))


# ── Orders and payments: the emails (Phase 12 moves these to templates) ──────

_ZERO_DECIMAL = {"JPY", "KRW", "VND", "CLP", "ISK", "UGX", "XAF", "XOF"}


def _amount(minor: Any, currency: str) -> str:
    value = int(minor or 0)
    if currency in _ZERO_DECIMAL:
        return f"{currency} {value:,}"
    return f"{currency} {value / 100:,.2f}"


async def _order_confirmation(worker: Worker, session: AsyncSession, event: PendingEvent) -> None:
    payload = event.payload
    currency = str(payload.get("currency", ""))
    items = await OrderService(session).items(event.aggregate_id)
    lines = "\n".join(
        f"  {item.quantity} x {item.product_title}"
        + (f" ({item.variant_title})" if item.variant_title else "")
        + f" — {_amount(item.unit_price_amount * item.quantity, currency)}"
        for item in items
    )
    link = _order_link(worker, event.aggregate_id, str(payload.get("order_number")))
    attachments: tuple[Attachment, ...] = ()
    order = await OrderRepository(session).get(event.aggregate_id)
    if order is not None:
        invoice = invoice_pdf(
            order, items, store_name=worker.settings.store_name, payment_label=None
        )
        attachments = (Attachment(f"invoice-{order.order_number}.pdf", invoice),)
    await worker.mailer.send(
        EmailMessage(
            to=str(payload["email"]),
            subject=f"Order {payload.get('order_number')} confirmed",
            text=(
                f"Thank you — your payment went through and your order "
                f"{payload.get('order_number')} is confirmed.\n\n{lines}\n\n"
                f"Total: {_amount(payload.get('total'), currency)}\n\n"
                f"Track it here: {link}\n\n"
                "Your invoice is attached. We will email you again when it ships."
            ),
            attachments=attachments,
        )
    )


def _order_link(worker: Worker, order_id: uuid.UUID, number: str) -> str:
    """The signed link: opens the order without signing in (PAGE-SPECS.md §1.4)."""
    token = order_token(worker.settings.secret_key.get_secret_value(), order_id)
    return f"{worker.settings.storefront_url}/orders/{number}?token={token}"


async def _order_shipped(worker: Worker, event: PendingEvent) -> None:
    payload = event.payload
    number = str(payload.get("order_number"))
    lines = "\n".join(
        f"  {line.get('quantity')} x {line.get('title')}"
        + (f" ({line.get('variant')})" if line.get("variant") else "")
        for line in payload.get("lines", [])
    )
    tracking = ""
    if payload.get("tracking_number"):
        carrier = str(payload.get("carrier") or "the carrier").upper()
        tracking = f"\n\nTracking with {carrier}: {payload['tracking_number']}"
        if payload.get("tracking_url"):
            tracking += f"\n{payload['tracking_url']}"
    rest = "" if payload.get("complete") else "\n\nThe rest of your order follows separately."
    await worker.mailer.send(
        EmailMessage(
            to=str(payload["email"]),
            subject=f"Order {number} is on its way",
            text=(
                f"Good news — order {number} has shipped:\n\n{lines}{tracking}{rest}\n\n"
                f"Your order: {_order_link(worker, event.aggregate_id, number)}"
            ),
        )
    )


async def _order_cancelled(worker: Worker, event: PendingEvent) -> None:
    payload = event.payload
    number = str(payload.get("order_number"))
    who = "as you asked" if payload.get("by_customer") else "by our team"
    await worker.mailer.send(
        EmailMessage(
            to=str(payload["email"]),
            subject=f"Order {number} is cancelled",
            text=(
                f"Order {number} has been cancelled {who}. Anything you paid is being "
                "refunded to your original payment method; you will get a separate email "
                "when the refund is issued."
            ),
        )
    )


async def _return_update(worker: Worker, event: PendingEvent) -> None:
    payload = event.payload
    number = str(payload.get("order_number"))
    rma = str(payload.get("rma_number"))
    note = f"\n\nNote from our team: {payload['note']}" if payload.get("note") else ""
    match event.event_type:
        case "return.requested":
            subject = f"We have your return request {rma}"
            body = (
                f"We have received your request to return items from order {number}. "
                "We will review it shortly and email you the next steps."
            )
            if worker.settings.ops_alert_email:
                await worker.mailer.send(
                    EmailMessage(
                        to=worker.settings.ops_alert_email,
                        subject=f"Return requested: {rma} (order {number})",
                        text="A customer has asked to return items. Review it in the admin.",
                    )
                )
        case "return.approved":
            subject = f"Return {rma} approved — how to send it back"
            body = (
                f"Your return {rma} for order {number} is approved. Print the return label "
                "from your order page, pack the items with it, and send the parcel to the "
                "address on the label. We refund once it arrives and is checked."
            )
        case _:
            subject = f"About your return request {rma}"
            body = (
                f"We are unable to accept the return {rma} for order {number}. "
                "Reply to this email if you have any questions."
            )
    await worker.mailer.send(
        EmailMessage(to=str(payload["email"]), subject=subject, text=body + note)
    )


async def _payment_failed(worker: Worker, event: PendingEvent) -> None:
    email = event.payload.get("email")
    if not email:
        return
    await worker.mailer.send(
        EmailMessage(
            to=str(email),
            subject="Your payment did not go through",
            text=(
                "Your card was declined, so we have not taken any money and your order "
                "has not been placed. Your cart is saved and the items are held for a "
                "little while — you can try another card or payment method from the "
                f"checkout.\n\n{worker.settings.storefront_url}/cart"
            ),
        )
    )


async def _refund_issued(worker: Worker, event: PendingEvent) -> None:
    payload = event.payload
    currency = str(payload.get("currency", ""))
    await worker.mailer.send(
        EmailMessage(
            to=str(payload["email"]),
            subject=f"Refund for order {payload.get('order_number')}",
            text=(
                f"We have refunded {_amount(payload.get('amount'), currency)} for order "
                f"{payload.get('order_number')}. It usually reaches your account within "
                "5 to 10 working days, depending on your bank."
            ),
        )
    )


async def _payments_alert(worker: Worker, event: PendingEvent) -> None:
    """Something about money needs a person. Logged at error level, and emailed."""
    logger.error("payments_alert", event_type=event.event_type, **event.payload)
    if not worker.settings.ops_alert_email:
        return
    details = "\n".join(f"{key}: {value}" for key, value in sorted(event.payload.items()))
    await worker.mailer.send(
        EmailMessage(
            to=worker.settings.ops_alert_email,
            subject=f"Payments alert: {event.event_type}",
            text=(
                f"{event.event_type} for {event.aggregate_type} {event.aggregate_id}\n\n"
                f"{details}\n\nWhat to do: docs/PAYMENTS-AND-CHECKOUT.md §12, Operating it."
            ),
        )
    )


# ── Payments ──────────────────────────────────────────────────────────────────


async def process_payment_event(ctx: dict[str, Any], event_id: str) -> str:
    async with open_session() as session:
        outcome = await _worker(ctx).event_processor(session).process(uuid.UUID(event_id))
    await ctx["redis"].enqueue_job(RELAY_JOB, _job_id=RELAY_JOB)  # the order's emails
    return outcome


async def retry_payment_events(ctx: dict[str, Any]) -> dict[str, int]:
    async with open_session() as session:
        counts = await _worker(ctx).event_processor(session).process_due()
    if counts:
        logger.info("payment_events_retried", **counts)
        await ctx["redis"].enqueue_job(RELAY_JOB, _job_id=RELAY_JOB)
    return counts


async def reconcile_payments(ctx: dict[str, Any]) -> dict[str, int]:
    async with open_session() as session:
        counts = await _worker(ctx).reconciler(session).run()
    if counts:
        await ctx["redis"].enqueue_job(RELAY_JOB, _job_id=RELAY_JOB)
    return counts


async def sweep_checkouts(ctx: dict[str, Any]) -> dict[str, int]:
    async with open_session() as session:
        return await CheckoutSweeper(session, InventoryService(session)).sweep()


async def reconcile_refunds(ctx: dict[str, Any]) -> dict[str, int]:
    async with open_session() as session:
        counts = await RefundService(session, _worker(ctx).providers).submit_stranded()
    if counts.get("found"):
        logger.info("refunds_reconciled", **counts)
        await ctx["redis"].enqueue_job(RELAY_JOB, _job_id=RELAY_JOB)
    return counts


# ── Media ─────────────────────────────────────────────────────────────────────


async def process_media(ctx: dict[str, Any], media_id: str) -> dict[str, Any]:
    worker = _worker(ctx)
    async with session_scope() as session:
        catalog = CatalogRepository(session)
        media = await catalog.media_item(uuid.UUID(media_id))
        if media is None:
            return {"status": "gone"}
        key = worker.storage.key_from_url(media.url)
        if key is None:
            return {"status": "external"}  # hosted elsewhere; nothing to derive
        original = await worker.storage.get(key)
        try:
            image = await asyncio.to_thread(process, original)
        except InvalidImageError:
            # Not an image after all, whatever its declared type: remove it.
            await catalog.delete_media(media.id)
            await worker.storage.delete_prefix(key.rsplit("/", 1)[0] + "/")
            record_event(session, "product", media.product_id, "product.updated", {})
            logger.warning("media_rejected", media_id=media_id)
            status = "rejected"
        else:
            folder = key.rsplit("/", 1)[0]
            renditions = []
            for rendition in image.renditions:
                url = await worker.storage.put(
                    f"{folder}/w{rendition.width}.{rendition.format}",
                    rendition.data,
                    rendition.content_type,
                )
                renditions.append(
                    {
                        "width": rendition.width,
                        "height": rendition.height,
                        "format": rendition.format,
                        "url": url,
                    }
                )
            await catalog.update_media(
                media.id,
                width=image.width,
                height=image.height,
                blurhash=image.blurhash,
                renditions=renditions,
            )
            record_event(session, "product", media.product_id, "product.updated", {})
            status = "processed"
    await ctx["redis"].enqueue_job(RELAY_JOB, _job_id=RELAY_JOB)
    logger.info("media_processed", media_id=media_id, status=status)
    return {"status": status}


# ── Search maintenance ────────────────────────────────────────────────────────


async def reindex_search(ctx: dict[str, Any]) -> dict[str, Any]:
    return await rebuild_index(_worker(ctx))


async def rebuild_index(worker: Worker) -> dict[str, Any]:
    """Zero-downtime rebuild. Writes made during the build are re-synced after the swap."""

    async def catch_up(since: datetime) -> int:
        async with session_scope() as session:
            events = await OutboxRepository(session).since(since)
            ids = _unique(
                _product_id(event) for event in events if event.event_type in _PRODUCT_EVENTS
            )
            await worker.indexer(session).sync(ids, wait=True)
            return len(ids)

    async with session_scope() as session:
        result = await worker.indexer(session).rebuild(since_hook=catch_up)
    logger.info("search_reindexed", **result)
    return result


async def reconcile_search(ctx: dict[str, Any]) -> dict[str, int]:
    worker = _worker(ctx)
    try:
        async with session_scope() as session:
            indexer = worker.indexer(session)
            missing, stale = await indexer.differences()
            if missing or stale:
                logger.warning("search_index_drift", missing=len(missing), stale=len(stale))
                await indexer.sync([*missing, *stale])
    except SearchUnavailableError as exc:
        logger.warning("search_reconcile_skipped", reason=str(exc)[:200])
        return {"missing": -1, "stale": -1}
    return {"missing": len(missing), "stale": len(stale)}


# ── Carts ─────────────────────────────────────────────────────────────────────


async def sweep_carts(ctx: dict[str, Any]) -> dict[str, int]:
    """Mark idle carts abandoned (for recovery email, Phase 12); drop expired guest carts."""
    settings = _worker(ctx).settings
    async with session_scope() as session:
        result = await CartSweeper(session).sweep(
            abandon_after=timedelta(hours=settings.cart_abandon_after_hours)
        )
    if any(result.values()):
        logger.info("carts_swept", **result)
    return result


# ── Lifecycle ─────────────────────────────────────────────────────────────────


async def startup(ctx: dict[str, Any]) -> None:
    settings = get_settings()
    configure_logging(
        level="DEBUG" if settings.debug else "INFO", json_output=settings.env != "development"
    )
    init_engine(settings)
    init_redis(settings)
    worker = Worker(settings)
    ctx["worker"] = worker
    try:
        async with session_scope() as session:
            await worker.indexer(session).ensure_index()
    except SearchUnavailableError as exc:
        logger.warning("search_index_setup_deferred", reason=str(exc)[:200])
    logger.info("worker_started")


async def shutdown(ctx: dict[str, Any]) -> None:
    worker: Worker | None = ctx.get("worker")
    if worker is not None:
        await worker.meili.aclose()
        await worker.providers.aclose()
    await close_redis()
    await dispose_engine()
    logger.info("worker_stopped")


class WorkerSettings:
    functions = [  # noqa: RUF012
        relay_outbox,
        process_media,
        reindex_search,
        reconcile_search,
        sweep_carts,
        process_payment_event,
        retry_payment_events,
        reconcile_payments,
        sweep_checkouts,
        reconcile_refunds,
    ]
    cron_jobs = [  # noqa: RUF012
        # The safety net under the post-commit kick: nothing waits longer than this.
        cron(relay_outbox, second={0, 10, 20, 30, 40, 50}, run_at_startup=True, unique=True),
        cron(reconcile_search, minute={17}, unique=True),
        cron(sweep_carts, minute={5, 20, 35, 50}, unique=True),
        # Payments. Reconciliation is the last job to disable and the first to test (§7).
        cron(retry_payment_events, second={30}, unique=True),
        cron(reconcile_payments, minute={0, 15, 30, 45}, run_at_startup=True, unique=True),
        cron(sweep_checkouts, second={15}, unique=True),
        cron(reconcile_refunds, minute=set(range(2, 60, 5)), unique=True),
    ]
    on_startup = startup
    on_shutdown = shutdown
    redis_settings = redis_settings(get_settings())
    max_jobs = 10
    job_timeout = 900  # a full reindex of a large catalog
    keep_result = 3600
