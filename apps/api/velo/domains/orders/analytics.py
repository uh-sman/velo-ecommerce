"""Store analytics for the admin (PLANNING.md Phase 11): revenue, products, funnel, cohorts.

**Revenue is money kept**: paid orders' totals less what was refunded, by the
day the order was placed. Pending and cancelled orders never count. Every
figure is computed in Postgres with one aggregate — never by loading orders —
so a year of history costs one query, not a year of rows.

Days are UTC days. A store-timezone setting would move the bucket edges;
until there is one, UTC is the honest answer and the API says so.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Literal

from sqlalchemy import (
    ColumnElement,
    Date,
    Select,
    Text,
    cast,
    column,
    distinct,
    func,
    select,
    table,
)
from sqlalchemy.ext.asyncio import AsyncSession

from velo.domains.orders.models import Order, OrderItem

COUNTED = ("paid", "processing", "partially_fulfilled", "fulfilled", "delivered",
           "refunded", "partially_refunded")  # fmt: skip
Interval = Literal["day", "week", "month"]

_carts = table("carts", column("id"), column("created_at"))
_checkouts = table("checkout_sessions", column("id"), column("created_at"))
_payments = table("payments", column("checkout_session_id"), column("created_at"))
_variants = table("product_variants", column("id"), column("product_id"))
_products = table("products", column("id"), column("title"), column("slug"))
_users = table("users", column("id"), column("created_at"), column("role"))


@dataclass(frozen=True, slots=True)
class Summary:
    currency: str
    revenue: int
    orders: int
    average_order_value: int
    refunded: int
    units: int
    new_customers: int
    previous_revenue: int
    previous_orders: int


@dataclass(frozen=True, slots=True)
class Point:
    period: date
    revenue: int
    orders: int


@dataclass(frozen=True, slots=True)
class TopProduct:
    product_id: uuid.UUID | None
    title: str
    slug: str | None
    units: int
    revenue: int


@dataclass(frozen=True, slots=True)
class FunnelStep:
    step: str
    count: int


@dataclass(frozen=True, slots=True)
class Cohort:
    month: date
    customers: int
    retained: list[float]  # share ordering again in month 1, 2, … after the first


def _counted(since: datetime, until: datetime) -> list[ColumnElement[bool]]:
    return [Order.status.in_(COUNTED), Order.placed_at >= since, Order.placed_at < until]


class AnalyticsService:
    def __init__(self, session: AsyncSession, *, currency: str) -> None:
        self._session = session
        self._currency = currency

    @property
    def currency(self) -> str:
        return self._currency

    async def summary(self, since: datetime, until: datetime) -> Summary:
        current = await self._totals(since, until)
        previous = await self._totals(since - (until - since), since)
        units = int(
            await self._session.scalar(
                select(func.coalesce(func.sum(OrderItem.quantity), 0))
                .join(Order, Order.id == OrderItem.order_id)
                .where(*_counted(since, until))
            )
            or 0
        )
        new_customers = int(
            await self._session.scalar(
                select(func.count())
                .select_from(_users)
                .where(
                    _users.c.created_at >= since,
                    _users.c.created_at < until,
                    _users.c.role == "customer",
                )
            )
            or 0
        )
        revenue, orders, refunded = current
        return Summary(
            currency=self._currency,
            revenue=revenue,
            orders=orders,
            average_order_value=revenue // orders if orders else 0,
            refunded=refunded,
            units=units,
            new_customers=new_customers,
            previous_revenue=previous[0],
            previous_orders=previous[1],
        )

    async def _totals(self, since: datetime, until: datetime) -> tuple[int, int, int]:
        row = (
            await self._session.execute(
                select(
                    func.coalesce(func.sum(Order.total_amount - Order.refunded_amount), 0),
                    func.count(),
                    func.coalesce(func.sum(Order.refunded_amount), 0),
                ).where(*_counted(since, until))
            )
        ).one()
        return int(row[0]), int(row[1]), int(row[2])

    async def revenue_series(
        self, since: datetime, until: datetime, interval: Interval
    ) -> list[Point]:
        bucket = cast(func.date_trunc(interval, func.timezone("UTC", Order.placed_at)), Date)
        rows = await self._session.execute(
            select(
                bucket.label("period"),
                func.coalesce(func.sum(Order.total_amount - Order.refunded_amount), 0),
                func.count(),
            )
            .where(*_counted(since, until))
            .group_by("period")
        )
        found = {period: (int(revenue), int(count)) for period, revenue, count in rows.all()}
        # Every bucket in the range, zeros included: a chart with gaps lies about the gaps.
        points: list[Point] = []
        cursor = _start_of(since.astimezone(UTC).date(), interval)
        last = (until - timedelta(microseconds=1)).astimezone(UTC).date()  # ``until`` is exclusive
        while cursor <= last:
            revenue, count = found.get(cursor, (0, 0))
            points.append(Point(period=cursor, revenue=revenue, orders=count))
            cursor = _next(cursor, interval)
        return points

    async def top_products(
        self, since: datetime, until: datetime, limit: int = 10
    ) -> list[TopProduct]:
        # A product still in the catalog groups by its id; one deleted since,
        # by the title the order line recorded.
        key = func.coalesce(cast(_products.c.id, Text), OrderItem.product_title)
        rows = await self._session.execute(
            select(
                func.max(cast(_products.c.id, Text)),
                func.coalesce(func.max(_products.c.title), func.max(OrderItem.product_title)),
                func.max(_products.c.slug),
                func.sum(OrderItem.quantity),
                func.sum(OrderItem.total_amount),
            )
            .select_from(OrderItem)
            .join(Order, Order.id == OrderItem.order_id)
            .outerjoin(_variants, _variants.c.id == OrderItem.variant_id)
            .outerjoin(_products, _products.c.id == _variants.c.product_id)
            .where(*_counted(since, until))
            .group_by(key)
            .order_by(func.sum(OrderItem.total_amount).desc())
            .limit(limit)
        )
        return [
            TopProduct(
                product_id=uuid.UUID(product_id) if product_id else None,
                title=str(title),
                slug=slug,
                units=int(units),
                revenue=int(revenue),
            )
            for product_id, title, slug, units, revenue in rows.all()
        ]

    async def funnel(self, since: datetime, until: datetime) -> list[FunnelStep]:
        """Carts → checkouts → payments started → orders, in the same window."""

        async def count(statement: Select[tuple[int]]) -> int:
            return int(await self._session.scalar(statement) or 0)

        carts = await count(
            select(func.count())
            .select_from(_carts)
            .where(_carts.c.created_at >= since, _carts.c.created_at < until)
        )
        checkouts = await count(
            select(func.count())
            .select_from(_checkouts)
            .where(_checkouts.c.created_at >= since, _checkouts.c.created_at < until)
        )
        paying = await count(
            select(func.count(distinct(_payments.c.checkout_session_id))).where(
                _payments.c.created_at >= since, _payments.c.created_at < until
            )
        )
        orders = await count(select(func.count()).select_from(Order).where(*_counted(since, until)))
        return [
            FunnelStep("carts", carts),
            FunnelStep("checkouts", checkouts),
            FunnelStep("payments", paying),
            FunnelStep("orders", orders),
        ]

    async def cohorts(self, months: int = 6, now: datetime | None = None) -> list[Cohort]:
        """Customers (by email, guests included) grouped by the month of their first order."""
        now = now or datetime.now(UTC)
        first_month = _add_months(date(now.year, now.month, 1), -(months - 1))
        month_of = cast(func.date_trunc("month", func.timezone("UTC", Order.placed_at)), Date)
        firsts = (
            select(Order.email.label("email"), func.min(month_of).label("cohort"))
            .where(Order.status.in_(COUNTED))
            .group_by(Order.email)
            .subquery()
        )
        activity = (
            select(Order.email.label("email"), month_of.label("month"))
            .where(Order.status.in_(COUNTED))
            .distinct()
            .subquery()
        )
        rows = await self._session.execute(
            select(firsts.c.cohort, activity.c.month, func.count(distinct(firsts.c.email)))
            .join(activity, activity.c.email == firsts.c.email)
            .where(firsts.c.cohort >= first_month)
            .group_by(firsts.c.cohort, activity.c.month)
        )
        counts: dict[date, dict[int, int]] = {}
        for cohort, month, n in rows.all():
            offset = (month.year - cohort.year) * 12 + (month.month - cohort.month)
            counts.setdefault(cohort, {})[offset] = int(n)
        result: list[Cohort] = []
        for index in range(months):
            month = _add_months(first_month, index)
            size = counts.get(month, {}).get(0, 0)
            elapsed = months - 1 - index
            retained = [
                round(counts.get(month, {}).get(k, 0) / size, 4) if size else 0.0
                for k in range(1, elapsed + 1)
            ]
            result.append(Cohort(month=month, customers=size, retained=retained))
        return result


def _start_of(day: date, interval: Interval) -> date:
    if interval == "month":
        return date(day.year, day.month, 1)
    if interval == "week":
        return day - timedelta(days=day.weekday())  # Postgres weeks start on Monday
    return day


def _next(day: date, interval: Interval) -> date:
    if interval == "month":
        return _add_months(day, 1)
    return day + timedelta(days=7 if interval == "week" else 1)


def _add_months(day: date, months: int) -> date:
    index = day.year * 12 + (day.month - 1) + months
    return date(index // 12, index % 12 + 1, 1)
