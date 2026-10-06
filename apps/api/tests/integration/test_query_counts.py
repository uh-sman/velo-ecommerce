"""Hot paths issue a fixed number of queries, however many rows a page holds.

Guards the N+1 fixes of the Phase 14 query review (docs/PERFORMANCE.md): each
test runs the same request over a small and a larger data set, and the
statement count must not grow with it.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from contextlib import asynccontextmanager
from typing import Any

import pytest
from fastapi import FastAPI
from sqlalchemy import event

from tests.integration.catalog_support import product, sql, variant
from tests.integration.checkout_support import start
from tests.integration.conftest import Browser, sign_in_as
from tests.integration.test_cart import add, shipping_and_tax

pytestmark = pytest.mark.integration

_NOT_QUERIES = ("SAVEPOINT", "RELEASE", "ROLLBACK", "BEGIN", "COMMIT")

Counter = Callable[[Callable[[], Awaitable[Any]]], Awaitable[int]]


@pytest.fixture
def count_queries(live_app: FastAPI) -> Iterator[Counter]:
    """``await count_queries(call)``: how many SQL statements ``call`` issued."""
    from velo.db.session import get_engine

    seen: list[str] = []

    def record(*args: Any) -> None:
        statement: str = args[2]
        if not statement.lstrip().upper().startswith(_NOT_QUERIES):
            seen.append(statement)

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", record)

    async def count(call: Callable[[], Awaitable[Any]]) -> int:
        seen.clear()
        response = await call()
        assert getattr(response, "status_code", 200) < 400, getattr(response, "text", response)
        return len(seen)

    yield count
    event.remove(engine, "before_cursor_execute", record)


def sizes(n: int, prefix: str) -> list[dict[str, Any]]:
    return [variant(options={"Size": f"{prefix}{i}"}) for i in range(n)]


async def test_a_product_listing_page_does_not_query_per_product(
    browser: Browser, admin: Browser, count_queries: Counter
) -> None:
    for i in range(2):
        await product(admin, f"Few {i}", variants=sizes(2, "F"))
    # A different limit each time: a new cache key, so the database answers.
    few = await count_queries(lambda: browser.get("/api/v1/products", params={"limit": 10}))
    for i in range(8):
        await product(admin, f"Many {i}", variants=sizes(4, "M"))
    many = await count_queries(lambda: browser.get("/api/v1/products", params={"limit": 11}))
    priced = await count_queries(
        lambda: browser.get("/api/v1/products", params={"limit": 12, "sort": "price"})
    )

    assert few == many == priced <= 3  # products with their stats, then images


async def test_the_admin_product_view_reads_stock_in_one_query(
    admin: Browser, count_queries: Counter
) -> None:
    small = await product(admin, "One size", variants=sizes(1, "S"))
    large = await product(admin, "Many sizes", variants=sizes(8, "L"))

    one = await count_queries(lambda: admin.get(f"/api/v1/admin/products/{small['id']}"))
    eight = await count_queries(lambda: admin.get(f"/api/v1/admin/products/{large['id']}"))

    assert one == eight


async def _orders(email: str, count: int, *, tag: str) -> None:
    """``count`` paid orders of two lines each, the first of them returned."""
    await sql(
        """
        INSERT INTO orders (order_number, user_id, email, status, payment_status, currency,
                            subtotal_amount, total_amount, shipping_address, billing_address,
                            placed_at)
        SELECT :tag || lpad(g::text, 4, '0'), u.id, u.email, 'paid', 'paid', 'USD', 1000, 1000,
               '{}'::jsonb, '{}'::jsonb, now() - g * interval '1 hour'
        FROM users u, generate_series(1, :count) g WHERE u.email = :email
        """,
        tag=tag,
        count=count,
        email=email,
    )
    await sql(
        """
        INSERT INTO order_items (order_id, product_title, variant_title, sku,
                                 unit_price_amount, quantity, total_amount, quantity_fulfilled)
        SELECT o.id, 'Thing', 'One', 'QC-' || line, 500, 1, 500, 1
        FROM orders o, generate_series(1, 2) line WHERE o.order_number LIKE :tag || '%'
        """,
        tag=tag,
    )
    await sql(
        """
        INSERT INTO returns (order_id, rma_number, reason)
        SELECT o.id, 'R' || o.order_number, 'Did not fit' FROM orders o
        WHERE o.order_number LIKE :tag || '%'
        """,
        tag=tag,
    )
    await sql(
        """
        INSERT INTO return_items (return_id, order_item_id, quantity)
        SELECT r.id, i.id, 1 FROM returns r JOIN order_items i ON i.order_id = r.order_id
        WHERE r.rma_number LIKE 'R' || :tag || '%'
        """,
        tag=tag,
    )


async def test_order_lists_do_not_query_per_order(
    browser: Browser, admin: Browser, count_queries: Counter
) -> None:
    await sign_in_as(browser, "buyer@example.com")
    await _orders("buyer@example.com", 2, tag="QA")
    account_few = await count_queries(lambda: browser.get("/api/v1/orders"))
    admin_few = await count_queries(lambda: admin.get("/api/v1/admin/orders"))
    returns_few = await count_queries(lambda: admin.get("/api/v1/admin/returns"))

    await _orders("buyer@example.com", 10, tag="QB")
    listed = await browser.get("/api/v1/orders")
    account_many = await count_queries(lambda: browser.get("/api/v1/orders"))
    admin_many = await count_queries(lambda: admin.get("/api/v1/admin/orders"))
    returns_many = await count_queries(lambda: admin.get("/api/v1/admin/returns"))

    assert len(listed.json()["data"]) == 12
    assert {order["item_count"] for order in listed.json()["data"]} == {2}
    assert account_few == account_many
    assert admin_few == admin_many
    assert returns_few == returns_many


async def test_starting_a_checkout_does_not_query_per_line(
    new_browser: Callable[[], Any], admin: Browser, count_queries: Counter
) -> None:
    await shipping_and_tax()
    made = await product(admin, "Socks", variants=sizes(5, "X"))
    variant_ids = [v["id"] for v in made["variants"]]

    @asynccontextmanager
    async def cart_of(lines: int) -> AsyncIterator[Browser]:
        async with new_browser() as shopper:
            for variant_id in variant_ids[:lines]:
                assert (await add(shopper, variant_id)).status_code == 200
            yield shopper

    async with cart_of(1) as shopper:
        one = await count_queries(lambda: start(shopper))
    async with cart_of(5) as shopper:
        five = await count_queries(lambda: start(shopper))

    assert one == five
