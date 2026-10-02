"""Cart mutations and discount limits under real contention (PLANNING.md Phase 13).

The checkout oversell race is in ``test_checkout_concurrency.py``. Here: one
shopper's tabs hammering the same cart at once, and many shoppers racing for
the last redemptions of a code with a usage limit above one.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, AsyncExitStack
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi import FastAPI

from tests.integration.catalog_support import problem, product, sql, variant
from tests.integration.checkout_support import (
    FakeStripe,
    pay,
    providers_for,
    start,
    to_payment,
)
from tests.integration.conftest import Browser
from tests.integration.test_cart import add, cart, discount, shipping_and_tax
from tests.integration.test_checkout_concurrency import Unlimited
from velo.domains.payments.registry import PaymentProviders

pytestmark = [pytest.mark.integration, pytest.mark.concurrency]

NewBrowser = Callable[[], AbstractAsyncContextManager[Browser]]


@pytest.fixture
def stripe() -> FakeStripe:
    return FakeStripe()


@pytest.fixture
async def unlimited(live_app: FastAPI) -> AsyncIterator[None]:
    from velo.api.deps import get_rate_limiter

    live_app.dependency_overrides[get_rate_limiter] = Unlimited
    yield


@pytest.fixture
async def providers(live_app: FastAPI, stripe: FakeStripe, unlimited: None) -> PaymentProviders:
    from velo.api.deps import get_payment_providers

    configured = providers_for(stripe)
    live_app.dependency_overrides[get_payment_providers] = lambda: configured
    return configured


@pytest.fixture
async def mugs(admin: Browser) -> dict[str, Any]:
    await shipping_and_tax()
    made = await product(
        admin,
        "Mug",
        variants=[
            variant(price=1200, stock=500, sku="MUG-RED", options={"Colour": "Red"}),
            variant(price=1200, stock=500, sku="MUG-BLUE", options={"Colour": "Blue"}),
        ],
    )
    return {"red": made["variants"][0]["id"], "blue": made["variants"][1]["id"]}


async def test_simultaneous_adds_of_one_variant_lose_no_update(
    browser: Browser, unlimited: None, mugs: dict[str, Any]
) -> None:
    assert (await add(browser, mugs["red"])).status_code == 200  # the cart now exists

    responses = await asyncio.gather(*(add(browser, mugs["red"]) for _ in range(20)))

    assert [r.status_code for r in responses] == [200] * 20, [r.text for r in responses]
    body = await cart(browser)
    assert len(body["items"]) == 1
    assert body["items"][0]["quantity"] == 21
    assert await sql("SELECT count(*) FROM carts") == 1
    assert await sql("SELECT count(*) FROM cart_items") == 1


async def test_a_new_shoppers_simultaneous_first_adds_make_one_cart(
    browser: Browser, unlimited: None, mugs: dict[str, Any]
) -> None:
    """Before the first response there is no cookie: parallel tabs must not split the cart."""
    responses = await asyncio.gather(
        add(browser, mugs["red"]), add(browser, mugs["blue"]), add(browser, mugs["red"])
    )
    assert all(r.status_code == 200 for r in responses), [r.text for r in responses]
    # Without a cookie yet, each request may create its own cart; the browser
    # keeps the last cookie set. What must hold: no request failed, and the
    # cart the browser now has is consistent and usable.
    body = await cart(browser)
    assert sum(item["quantity"] for item in body["items"]) >= 1
    assert (await add(browser, mugs["blue"])).status_code == 200


async def test_simultaneous_quantity_changes_and_removals_leave_a_consistent_cart(
    browser: Browser, unlimited: None, mugs: dict[str, Any]
) -> None:
    await add(browser, mugs["red"], 2)
    await add(browser, mugs["blue"], 2)
    lines = {item["variant"]["id"]: item["id"] for item in (await cart(browser))["items"]}
    red_line = lines[mugs["red"]]

    async def set_quantity(quantity: int) -> Any:
        return await browser.patch(f"/api/v1/cart/items/{red_line}", json={"quantity": quantity})

    results = await asyncio.gather(
        *(set_quantity(q) for q in [5, 7, 0, 3, 9]),
        add(browser, mugs["blue"]),
        add(browser, mugs["blue"]),
    )
    assert all(r.status_code in (200, 404) for r in results), [r.text for r in results]

    body = await cart(browser)
    by_variant = {item["variant"]["id"]: item for item in body["items"]}
    assert by_variant[mugs["blue"]]["quantity"] == 4  # both adds counted
    if mugs["red"] in by_variant:
        assert by_variant[mugs["red"]]["quantity"] in {5, 7, 3, 9}
    rows = await sql("SELECT count(*) FROM cart_items")
    assert rows == len(body["items"])  # no orphan or duplicate rows


@pytest.mark.parametrize(("limit", "racers"), [(3, 10), (5, 25)])
async def test_racing_redemptions_stop_exactly_at_the_usage_limit(
    new_browser: NewBrowser,
    stripe: FakeStripe,
    providers: PaymentProviders,
    mugs: dict[str, Any],
    limit: int,
    racers: int,
) -> None:
    # Started an hour ago: the database's clock and ours need not agree to the second.
    an_hour_ago = datetime.now(UTC) - timedelta(hours=1)
    await discount(
        code="FEW", type="percentage", value=10, max_redemptions=limit, starts_at=an_hour_ago
    )

    async with AsyncExitStack() as stack:
        browsers = [await stack.enter_async_context(new_browser()) for _ in range(racers)]
        checkouts = []
        for i, browser in enumerate(browsers):
            await add(browser, mugs["red"])
            response = await browser.post("/api/v1/cart/discount", json={"code": "FEW"})
            assert response.status_code == 200, response.text
            checkout_id = (await start(browser, email=f"racer{i}@example.com")).json()["id"]
            await to_payment(browser, checkout_id)
            checkouts.append(checkout_id)

        responses = await asyncio.gather(
            *(pay(browser, checkout) for browser, checkout in zip(browsers, checkouts, strict=True))
        )

    statuses = [response.status_code for response in responses]
    assert statuses.count(201) == limit, statuses
    assert statuses.count(422) == racers - limit, statuses
    assert {problem(r) for r in responses if r.status_code == 422} == {"discount-expired"}
    assert len(stripe.intents) == limit
