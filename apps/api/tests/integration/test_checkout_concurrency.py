"""The oversell guard under real contention (PLANNING.md 8.2, PAYMENTS-AND-CHECKOUT.md §11).

N shoppers, one unit of stock, N simultaneous ``POST /checkout`` requests —
each a real transaction against Postgres, racing for the same inventory row.
Exactly one reserves the unit; the other N-1 get a clean ``409 out-of-stock``.
The winner then pays, and there is exactly one order and no negative stock.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, AsyncExitStack
from typing import Any

import pytest
from fastapi import FastAPI

from tests.integration.catalog_support import problem, product, sql, variant
from tests.integration.checkout_support import (
    FakeStripe,
    deliver,
    pay,
    process_events,
    providers_for,
    start,
    to_payment,
)
from tests.integration.conftest import Browser
from tests.integration.test_cart import add, discount, shipping_and_tax
from velo.core.rate_limit import RateLimitStatus, Rule
from velo.domains.payments.registry import PaymentProviders

pytestmark = [pytest.mark.integration, pytest.mark.concurrency]

NewBrowser = Callable[[], AbstractAsyncContextManager[Browser]]


class Unlimited:
    """A rate limiter that allows everything: N shoppers here share one test IP."""

    async def hit(self, rule: Rule, subject: str) -> RateLimitStatus:
        return RateLimitStatus(True, rule.limit, rule.limit, rule.window_seconds)

    async def peek(self, rule: Rule, subject: str) -> RateLimitStatus:
        return await self.hit(rule, subject)

    async def reset(self, rule: Rule, subject: str) -> None:
        return None


@pytest.fixture
def stripe() -> FakeStripe:
    return FakeStripe()


@pytest.fixture
async def providers(live_app: FastAPI, stripe: FakeStripe) -> AsyncIterator[PaymentProviders]:
    from velo.api.deps import get_payment_providers, get_rate_limiter

    configured = providers_for(stripe)
    live_app.dependency_overrides[get_payment_providers] = lambda: configured
    live_app.dependency_overrides[get_rate_limiter] = Unlimited
    yield configured


@pytest.fixture
async def last_one(admin: Browser) -> dict[str, Any]:
    await shipping_and_tax()
    made = await product(admin, "Last One", variants=[variant(price=5000, stock=1, sku="LAST-1")])
    return dict(made["variants"][0])


@pytest.mark.parametrize("shoppers", [2, 10, 100])
async def test_n_simultaneous_checkouts_for_one_unit_make_exactly_one_order(
    new_browser: NewBrowser,
    stripe: FakeStripe,
    providers: PaymentProviders,
    last_one: dict[str, Any],
    shoppers: int,
) -> None:
    async with AsyncExitStack() as stack:
        browsers = [await stack.enter_async_context(new_browser()) for _ in range(shoppers)]
        for browser in browsers:  # each has the unit in their cart: it is not reserved yet
            assert (await add(browser, last_one["id"])).status_code == 200

        responses = await asyncio.gather(
            *(start(browser, email=f"shopper{i}@example.com") for i, browser in enumerate(browsers))
        )

        statuses = [response.status_code for response in responses]
        assert statuses.count(201) == 1, statuses
        assert statuses.count(409) == shoppers - 1, statuses
        assert {problem(r) for r in responses if r.status_code == 409} <= {"out-of-stock"}
        assert await sql("SELECT quantity_reserved FROM inventory_items") == 1

        winner_index = statuses.index(201)
        winner = browsers[winner_index]
        checkout_id = responses[winner_index].json()["id"]
        await to_payment(winner, checkout_id)
        assert (await pay(winner, checkout_id)).status_code == 201
        intent_id = stripe.only_intent()
        stripe.succeed(intent_id)
        await deliver(winner, stripe.event("payment_intent.succeeded", intent_id))
        await process_events(providers)

    assert await sql("SELECT count(*) FROM orders") == 1
    assert await sql("SELECT quantity_on_hand FROM inventory_items") == 0
    assert await sql("SELECT quantity_reserved FROM inventory_items") == 0
    assert await sql("SELECT count(*) FROM checkout_sessions") == 1  # losers rolled back whole


async def test_simultaneous_payments_racing_for_a_single_use_code_let_exactly_one_through(
    new_browser: NewBrowser, stripe: FakeStripe, providers: PaymentProviders, admin: Browser
) -> None:
    await shipping_and_tax()
    made = await product(admin, "Plenty", variants=[variant(price=5000, stock=50, sku="PLENTY")])
    variant_id = made["variants"][0]["id"]
    await discount(code="SOLO", type="percentage", value=20, max_redemptions=1)

    async with AsyncExitStack() as stack:
        browsers = [await stack.enter_async_context(new_browser()) for _ in range(8)]
        checkouts = []
        for i, browser in enumerate(browsers):
            await add(browser, variant_id)
            assert (
                await browser.post("/api/v1/cart/discount", json={"code": "SOLO"})
            ).status_code == 200
            checkout_id = (await start(browser, email=f"racer{i}@example.com")).json()["id"]
            await to_payment(browser, checkout_id)
            checkouts.append(checkout_id)

        responses = await asyncio.gather(
            *(pay(browser, checkout) for browser, checkout in zip(browsers, checkouts, strict=True))
        )

    statuses = sorted(response.status_code for response in responses)
    assert statuses == [201] + [422] * 7, statuses
    assert {problem(r) for r in responses if r.status_code == 422} == {"discount-expired"}
    assert len(stripe.intents) == 1
    discounted = 4000 + 599 + 290  # 20% off $50.00, standard shipping, 7.25% of $40.00
    assert stripe.intents[stripe.only_intent()]["amount"] == discounted
