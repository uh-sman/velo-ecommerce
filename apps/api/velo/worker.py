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
from datetime import UTC, datetime, timedelta
from typing import Any

from arq import cron
from sqlalchemy.ext.asyncio import AsyncSession

import velo.db.models  # noqa: F401 — register every mapper; FKs cross domains
from velo.core.config import Settings, get_settings
from velo.core.email import Attachment, EmailMessage, Mailer, SmtpMailer
from velo.core.jobs import RELAY_JOB, redis_settings
from velo.core.logging import configure_logging, get_logger
from velo.core.meili import MeiliClient, SearchUnavailableError
from velo.core.rate_limit import RateLimiter
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
from velo.domains.orders.analytics import AnalyticsService
from velo.domains.orders.documents import invoice_pdf
from velo.domains.orders.refunds import RefundService
from velo.domains.orders.repository import OrderRepository
from velo.domains.orders.rules import order_token
from velo.domains.orders.service import OrderService
from velo.domains.payments.registry import PaymentProviders, build_providers
from velo.domains.platform.events import OutboxRepository, PendingEvent, record_event
from velo.domains.platform.job_failures import MAX_TRIES, retrying
from velo.domains.system.worker_health import HEARTBEAT_KEY
from velo.emails.cart_recovery import CartRecovery
from velo.emails.service import EmailService
from velo.emails.transport import Transport, build_transport

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
        self.mailer: Mailer = SmtpMailer(settings)  # internal alerts: best effort
        self.transport: Transport = build_transport(settings)  # customer email: retried
        self.cache = CatalogCache(get_redis(), settings.catalog_cache_ttl_seconds)
        self.providers: PaymentProviders = build_providers(settings)

    def emails(self, session: AsyncSession | None = None) -> EmailService:
        """Customer email. Writes its log in sessions of its own (emails/service.py)."""
        del session
        return EmailService(self.settings, self.transport, RateLimiter(get_redis()))

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
    emails = worker.emails(session)
    match event.event_type:
        case "inventory.low_stock":
            await _low_stock_alert(worker, event)
        case "inventory.restocked":
            await _back_in_stock(worker, session, emails, event.aggregate_id)
        case "media.uploaded":
            await ctx["redis"].enqueue_job("process_media", str(event.aggregate_id))
        case "media.deleted":
            await worker.storage.delete_prefix(event.payload["prefix"])
        case "order.created":
            await _order_confirmation(worker, session, emails, event)
        case "order.shipped":
            await _order_shipped(worker, emails, event)
        case "order.delivered":
            await _order_delivered(worker, emails, event)
        case "order.cancelled":
            await _send(emails, "order_cancelled", event, {
                "order_number": event.payload.get("order_number"),
                "by_customer": bool(event.payload.get("by_customer")),
            })  # fmt: skip
        case "payment.failed":
            if event.payload.get("email"):
                await _send(emails, "payment_failed", event, {
                    "cart_url": f"{worker.settings.storefront_url}/cart"
                })  # fmt: skip
        case "refund.issued":
            currency = str(event.payload.get("currency", ""))
            await _send(emails, "refund_issued", event, {
                "order_number": event.payload.get("order_number"),
                "amount": _amount(event.payload.get("amount"), currency),
            })  # fmt: skip
        case "return.requested" | "return.approved" | "return.rejected":
            await _return_update(worker, emails, event)
        case "user.registered":
            await _send(emails, "welcome", event, {
                "first_name": event.payload.get("first_name"),
                "shop_url": f"{worker.settings.storefront_url}/products",
            })  # fmt: skip
        case (
            "order.needs_attention"
            | "order.dispute_opened"
            | "payment.duplicate"
            | "payment.stuck"
            | "payment_event.dead_lettered"
            | "refund.needs_attention"
            | "job.dead_lettered"
        ):
            await _payments_alert(worker, event)
        case _:
            logger.info("outbox_event_ignored", event_type=event.event_type)


async def _send(
    emails: EmailService,
    kind: str,
    event: PendingEvent,
    context: dict[str, Any],
    *,
    attachments: tuple[Attachment, ...] = (),
) -> None:
    """One customer email per outbox event, however often the event is relayed."""
    await emails.send(
        kind,
        str(event.payload["email"]),
        context,
        dedupe_key=f"{event.event_type}:{event.id}",
        attachments=attachments,
    )


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


async def _back_in_stock(
    worker: Worker, session: AsyncSession, emails: EmailService, variant_id: uuid.UUID
) -> None:
    inventory = InventoryService(session)
    label, subscribers = await inventory.claim_subscribers(variant_id)
    if label is None or not subscribers:
        return
    link = f"{worker.settings.storefront_url}/products/{label.product_slug}"
    for subscriber in subscribers:
        await emails.send(
            "back_in_stock",
            subscriber.email,
            {
                "product_title": label.product_title,
                "variant_title": label.variant_title,
                "product_url": link,
            },
            dedupe_key=f"back_in_stock:{subscriber.id}",
        )
    # Committed with the relay's batch; a retry after a crash re-sends nothing,
    # because each email is deduplicated by its key in sent_emails.
    await inventory.mark_notified([subscriber.id for subscriber in subscribers])
    logger.info("back_in_stock_notified", sku=label.sku, subscribers=len(subscribers))


# ── Orders and payments: the emails (templates in velo/emails, ADR-011) ──────

_ZERO_DECIMAL = {"JPY", "KRW", "VND", "CLP", "ISK", "UGX", "XAF", "XOF"}


def _amount(minor: Any, currency: str) -> str:
    value = int(minor or 0)
    if currency in _ZERO_DECIMAL:
        return f"{currency} {value:,}"
    return f"{currency} {value / 100:,.2f}"


def _order_link(worker: Worker, order_id: uuid.UUID, number: str) -> str:
    """The signed link: opens the order without signing in (PAGE-SPECS.md §1.4)."""
    token = order_token(worker.settings.secret_key.get_secret_value(), order_id)
    return f"{worker.settings.storefront_url}/orders/{number}?token={token}"


async def _order_confirmation(
    worker: Worker, session: AsyncSession, emails: EmailService, event: PendingEvent
) -> None:
    payload = event.payload
    currency = str(payload.get("currency", ""))
    number = str(payload.get("order_number"))
    items = await OrderService(session).items(event.aggregate_id)
    attachments: tuple[Attachment, ...] = ()
    order = await OrderRepository(session).get(event.aggregate_id)
    if order is not None:
        invoice = invoice_pdf(
            order, items, store_name=worker.settings.store_name, payment_label=None
        )
        attachments = (Attachment(f"invoice-{order.order_number}.pdf", invoice),)
    await emails.send(
        "order_confirmed",
        str(payload["email"]),
        {
            "order_number": number,
            "lines": [
                {
                    "quantity": item.quantity,
                    "title": item.product_title,
                    "variant": item.variant_title,
                    "amount": _amount(item.unit_price_amount * item.quantity, currency),
                }
                for item in items
            ],
            "total": _amount(payload.get("total"), currency),
            "order_url": _order_link(worker, event.aggregate_id, number),
        },
        # The order's own id: one confirmation per order, whatever the relay does.
        dedupe_key=f"order.created:{event.aggregate_id}",
        attachments=attachments,
    )


async def _order_shipped(worker: Worker, emails: EmailService, event: PendingEvent) -> None:
    payload = event.payload
    number = str(payload.get("order_number"))
    await _send(emails, "order_shipped", event, {
        "order_number": number,
        "lines": [
            {"quantity": line.get("quantity"), "title": line.get("title"),
             "variant": line.get("variant"), "amount": None}
            for line in payload.get("lines", [])
        ],
        "carrier": (payload.get("carrier") or "").upper() or None,
        "tracking_number": payload.get("tracking_number"),
        "tracking_url": payload.get("tracking_url"),
        "complete": bool(payload.get("complete")),
        "order_url": _order_link(worker, event.aggregate_id, number),
    })  # fmt: skip


async def _order_delivered(worker: Worker, emails: EmailService, event: PendingEvent) -> None:
    number = str(event.payload.get("order_number"))
    await _send(emails, "order_delivered", event, {
        "order_number": number,
        "order_url": _order_link(worker, event.aggregate_id, number),
        "return_window_days": worker.settings.return_window_days,
    })  # fmt: skip


async def _return_update(worker: Worker, emails: EmailService, event: PendingEvent) -> None:
    payload = event.payload
    status = event.event_type.removeprefix("return.")
    await _send(emails, "return_update", event, {
        "status": status,
        "rma_number": payload.get("rma_number"),
        "order_number": payload.get("order_number"),
        "note": payload.get("note"),
        "order_url": f"{worker.settings.storefront_url}/orders/lookup",
    })  # fmt: skip
    if status == "requested" and worker.settings.ops_alert_email:
        await worker.mailer.send(
            EmailMessage(
                to=worker.settings.ops_alert_email,
                subject=f"Return requested: {payload.get('rma_number')} "
                f"(order {payload.get('order_number')})",
                text="A customer has asked to return items. Review it in the admin.",
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


@retrying
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


@retrying
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


async def remind_abandoned_carts(ctx: dict[str, Any]) -> dict[str, int]:
    """The 1 h / 24 h / 72 h reminder sequence (emails/cart_recovery.py)."""
    worker = _worker(ctx)
    async with open_session() as session:
        counts = await CartRecovery(session, worker.settings, worker.emails()).run()
    if any(counts.values()):
        logger.info("cart_reminders", **counts)
    return counts


# ── Health and the nightly digest ─────────────────────────────────────────────


async def heartbeat(ctx: dict[str, Any]) -> None:
    """Proof of life for /system/worker: a timestamp that expires if we stop."""
    await get_redis().set(HEARTBEAT_KEY, datetime.now(UTC).isoformat(), ex=120)


async def nightly_digest(ctx: dict[str, Any]) -> dict[str, Any]:
    """Yesterday in one email to ops: sales, refunds, and what is low on stock.

    Analytics are computed live from orders (orders/analytics.py) — fast enough
    with the indexes there — so the nightly rollup is this digest rather than
    a summary table to keep in step.
    """
    worker = _worker(ctx)
    now = datetime.now(UTC)
    until = datetime(now.year, now.month, now.day, tzinfo=UTC)
    since = until - timedelta(days=1)
    async with open_session() as session:
        summary = await AnalyticsService(session, currency=worker.settings.currency).summary(
            since, until
        )
        low, _, _ = await InventoryService(session).list_stock(
            low_stock_only=True, query_text=None, limit=20, after=None
        )
    if worker.settings.ops_alert_email:
        lines = "\n".join(
            f"  {row.sku} — {row.product_title} ({row.variant_title}): {row.stock.available} left"
            for row in low
        )
        money = summary.currency
        await worker.mailer.send(
            EmailMessage(
                to=worker.settings.ops_alert_email,
                subject=f"{worker.settings.store_name} — {since.date().isoformat()}",
                text=(
                    f"Revenue: {_amount(summary.revenue, money)} from {summary.orders} orders "
                    f"(average {_amount(summary.average_order_value, money)}).\n"
                    f"Refunded: {_amount(summary.refunded, money)}. "
                    f"New customers: {summary.new_customers}.\n\n"
                    + (f"Low stock:\n{lines}" if lines else "Nothing is low on stock.")
                ),
            )
        )
    return {"revenue": summary.revenue, "orders": summary.orders, "low_stock": len(low)}


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
        remind_abandoned_carts,
        heartbeat,
        nightly_digest,
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
        # Email.
        cron(remind_abandoned_carts, minute={7, 22, 37, 52}, unique=True),
        # Operations.
        cron(heartbeat, second={5, 35}, run_at_startup=True, unique=True),
        cron(nightly_digest, hour={2}, minute={30}, unique=True),
    ]
    on_startup = startup
    on_shutdown = shutdown
    redis_settings = redis_settings(get_settings())
    max_jobs = 10
    # Queued jobs wrapped in ``retrying`` back off and dead-letter after this many tries.
    max_tries = MAX_TRIES
    job_timeout = 900  # a full reindex of a large catalog
    keep_result = 3600
