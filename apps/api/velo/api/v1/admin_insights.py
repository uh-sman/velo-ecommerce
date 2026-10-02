"""/admin/analytics, /admin/audit-log, /admin/saved-views — reading the store.

Analytics need ``reports:read`` and accept ``since``/``until`` (``until``
exclusive; default: the last 30 days). Every report also comes as CSV with
``?format=csv``, for the spreadsheet someone will inevitably want. Days are
UTC days.
"""

from __future__ import annotations

import csv
import io
import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query, Response, status
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from velo.api.deps import AdminDep, AnalyticsDep, AuditReaderDep, ReportsReaderDep, SessionDep
from velo.core.errors import ValidationError
from velo.core.pagination import CursorPage, PaginationInfo, decode_cursor, encode_cursor
from velo.domains.platform.audit import AuditFilter, AuditReader, SavedViews

router = APIRouter(prefix="/admin", tags=["admin: insights"])

Format = Literal["json", "csv"]


def _window(since: datetime | None, until: datetime | None) -> tuple[datetime, datetime]:
    end = until or datetime.now(UTC)
    start = since or end - timedelta(days=30)
    if start >= end:
        raise ValidationError("`since` must be before `until`.")
    if end - start > timedelta(days=3 * 366):
        raise ValidationError("Choose a window of at most three years.")
    return start, end


def _csv(filename: str, header: list[str], rows: list[list[Any]]) -> Response:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(header)
    writer.writerows(rows)
    return Response(
        buffer.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


class SummaryView(BaseModel):
    since: datetime
    until: datetime
    currency: str
    revenue: int
    orders: int
    average_order_value: int
    refunded: int
    units: int
    new_customers: int
    previous_revenue: int
    previous_orders: int


class PointView(BaseModel):
    period: date
    revenue: int
    orders: int
    currency: str


class TopProductView(BaseModel):
    product_id: uuid.UUID | None
    title: str
    slug: str | None
    units: int
    revenue: int
    currency: str


class FunnelView(BaseModel):
    step: str
    count: int


class CohortView(BaseModel):
    month: date
    customers: int
    retained: list[float]


Since = Annotated[datetime | None, Query(description="Start, inclusive. Default: 30 days ago.")]
Until = Annotated[datetime | None, Query(description="End, exclusive. Default: now.")]


@router.get("/analytics/summary", response_model=SummaryView, summary="Headline figures")
async def summary(
    _: ReportsReaderDep, service: AnalyticsDep, since: Since = None, until: Until = None
) -> SummaryView:
    start, end = _window(since, until)
    result = await service.summary(start, end)
    return SummaryView(
        since=start,
        until=end,
        currency=result.currency,
        revenue=result.revenue,
        orders=result.orders,
        average_order_value=result.average_order_value,
        refunded=result.refunded,
        units=result.units,
        new_customers=result.new_customers,
        previous_revenue=result.previous_revenue,
        previous_orders=result.previous_orders,
    )


@router.get("/analytics/revenue", response_model=list[PointView], summary="Revenue over time")
async def revenue(
    _: ReportsReaderDep,
    service: AnalyticsDep,
    since: Since = None,
    until: Until = None,
    interval: Literal["day", "week", "month"] = "day",
    format: Format = "json",  # noqa: A002 — the query parameter's name
) -> Any:
    start, end = _window(since, until)
    points = await service.revenue_series(start, end, interval)
    if format == "csv":
        return _csv(
            "revenue.csv",
            ["period", "revenue_minor_units", "orders"],
            [[p.period.isoformat(), p.revenue, p.orders] for p in points],
        )
    currency = service.currency
    return [
        PointView(period=p.period, revenue=p.revenue, orders=p.orders, currency=currency)
        for p in points
    ]


@router.get("/analytics/products", response_model=list[TopProductView], summary="Top products")
async def top_products(
    _: ReportsReaderDep,
    service: AnalyticsDep,
    since: Since = None,
    until: Until = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 10,
    format: Format = "json",  # noqa: A002
) -> Any:
    start, end = _window(since, until)
    products = await service.top_products(start, end, limit)
    if format == "csv":
        return _csv(
            "top-products.csv",
            ["product", "units", "revenue_minor_units"],
            [[p.title, p.units, p.revenue] for p in products],
        )
    return [
        TopProductView(
            product_id=p.product_id,
            title=p.title,
            slug=p.slug,
            units=p.units,
            revenue=p.revenue,
            currency=service.currency,
        )
        for p in products
    ]


@router.get("/analytics/funnel", response_model=list[FunnelView], summary="Carts to orders")
async def funnel(
    _: ReportsReaderDep, service: AnalyticsDep, since: Since = None, until: Until = None
) -> list[FunnelView]:
    start, end = _window(since, until)
    return [FunnelView(step=s.step, count=s.count) for s in await service.funnel(start, end)]


@router.get("/analytics/cohorts", response_model=list[CohortView], summary="Monthly retention")
async def cohorts(
    _: ReportsReaderDep,
    service: AnalyticsDep,
    months: Annotated[int, Query(ge=2, le=24)] = 6,
    format: Format = "json",  # noqa: A002
) -> Any:
    found = await service.cohorts(months)
    if format == "csv":
        width = max((len(c.retained) for c in found), default=0)
        return _csv(
            "cohorts.csv",
            ["month", "customers", *[f"month_{k}" for k in range(1, width + 1)]],
            [[c.month.isoformat(), c.customers, *c.retained] for c in found],
        )
    return [CohortView(month=c.month, customers=c.customers, retained=c.retained) for c in found]


# ── Audit log ─────────────────────────────────────────────────────────────────


class AuditView(BaseModel):
    id: uuid.UUID
    actor_id: uuid.UUID | None
    actor_email: str | None
    action: str
    entity_type: str
    entity_id: uuid.UUID | None
    changes: dict[str, Any] | None
    ip_address: str | None
    created_at: datetime


@router.get("/audit-log", response_model=CursorPage[AuditView], summary="Who did what")
async def audit_log(
    _: AuditReaderDep,
    session: SessionDep,
    actor: Annotated[str | None, Query(max_length=200, description="Email of the actor.")] = None,
    entity_type: Annotated[str | None, Query(max_length=60)] = None,
    entity_id: uuid.UUID | None = None,
    action: Annotated[
        str | None, Query(max_length=80, description="Exact, or a prefix ending in '.'.")
    ] = None,
    since: datetime | None = None,
    until: datetime | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    cursor: str | None = None,
) -> CursorPage[AuditView]:
    after = decode_cursor(cursor, "audit") if cursor else None
    entries, has_more = await AuditReader(session).search(
        AuditFilter(
            actor_email=actor,
            entity_type=entity_type,
            entity_id=entity_id,
            action=action,
            since=since,
            until=until,
        ),
        limit=limit,
        after=after,
    )
    last = entries[-1] if entries else None
    return CursorPage[AuditView](
        data=[
            AuditView(
                id=e.id,
                actor_id=e.actor_id,
                actor_email=e.actor_email,
                action=e.action,
                entity_type=e.entity_type,
                entity_id=e.entity_id,
                changes=e.changes,
                ip_address=e.ip_address,
                created_at=e.created_at,
            )
            for e in entries
        ],
        pagination=PaginationInfo(
            next_cursor=encode_cursor("audit", last.created_at, last.id)
            if has_more and last
            else None,
            has_more=has_more,
            limit=limit,
        ),
    )


# ── Saved views ───────────────────────────────────────────────────────────────


class ViewIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scope: Literal["orders", "products", "customers"]
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)]
    query: Annotated[dict[str, Any], Field(description="The list's query parameters.")]


class ViewOut(BaseModel):
    id: uuid.UUID
    scope: str
    name: str
    query: dict[str, Any]


@router.get("/saved-views", response_model=list[ViewOut], summary="My saved filters")
async def list_views(
    principal: AdminDep, session: SessionDep, scope: Literal["orders", "products", "customers"]
) -> list[ViewOut]:
    return [
        ViewOut(id=v.id, scope=v.scope, name=v.name, query=v.query)
        for v in await SavedViews(session).list(principal.user_id, scope)
    ]


@router.post("/saved-views", response_model=ViewOut, status_code=status.HTTP_201_CREATED)
async def save_view(body: ViewIn, principal: AdminDep, session: SessionDep) -> ViewOut:
    view = await SavedViews(session).save(principal.user_id, body.scope, body.name, body.query)
    return ViewOut(id=view.id, scope=view.scope, name=view.name, query=view.query)


@router.delete("/saved-views/{view_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_view(view_id: uuid.UUID, principal: AdminDep, session: SessionDep) -> Response:
    await SavedViews(session).delete(principal.user_id, view_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
