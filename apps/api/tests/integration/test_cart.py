"""The cart end to end, against real Postgres and Redis (PLANNING.md Phase 7).

Definition of Done: a client cannot influence any price. Every test that adds
to a cart sends a variant and a quantity — the only things a client can send.
"""

from __future__ import annotations

from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from datetime import UTC, datetime
from typing import Any

import pytest

from tests.integration.catalog_support import problem, product, sql, variant
from tests.integration.conftest import Browser, sign_in_as

pytestmark = pytest.mark.integration

NewBrowser = Callable[[], AbstractAsyncContextManager[Browser]]
US_CA = {"country": "US", "region": "CA", "postal_code": "94103"}


async def discount(**fields: Any) -> None:
    """A discount row. Codes are created by the admin in Phase 11; tests insert them."""
    fields = {"title": fields.get("code") or "automatic", "value": 10, **fields}
    columns = ", ".join(fields)
    values = ", ".join(f":{key}" for key in fields)
    # Column names come from this test file, never from input; values are bound.
    await sql(f"INSERT INTO discounts ({columns}) VALUES ({values})", **fields)  # noqa: S608


async def shipping_and_tax() -> None:
    await sql(
        "INSERT INTO shipping_zones (id, name, country_codes) VALUES "
        "('00000000-0000-7000-8000-000000000001', 'US', ARRAY['US']::char(2)[])"
    )
    await sql(
        """
        INSERT INTO shipping_rates (zone_id, name, price_amount, min_subtotal_amount,
                                    max_subtotal_amount, position)
        VALUES ('00000000-0000-7000-8000-000000000001', 'Standard', 599, NULL, 7499, 0),
               ('00000000-0000-7000-8000-000000000001', 'Free standard', 0, 7500, NULL, 1),
               ('00000000-0000-7000-8000-000000000001', 'Express', 1499, NULL, NULL, 2)
        """
    )
    await sql(
        "INSERT INTO tax_rates (name, country_code, region, rate) "
        "VALUES ('CA sales tax', 'US', 'CA', 0.0725)"
    )


async def add(browser: Browser, variant_id: str, quantity: int = 1, **params: Any) -> Any:
    return await browser.post(
        "/api/v1/cart/items", json={"variant_id": variant_id, "quantity": quantity}, params=params
    )


async def cart(browser: Browser, **params: Any) -> dict[str, Any]:
    response = await browser.get("/api/v1/cart", params=params)
    assert response.status_code == 200, response.text
    return dict(response.json())


def codes(body: dict[str, Any]) -> list[str]:
    return [warning["code"] for warning in body["warnings"]]


@pytest.fixture
async def tee(admin: Browser) -> dict[str, Any]:
    return await product(admin, "Cart Tee", variants=[variant(price=2800, stock=10, sku="CT-1")])


# ── Ownership ─────────────────────────────────────────────────────────────────


async def test_a_guest_cart_lives_in_an_httponly_cookie(
    browser: Browser, new_browser: NewBrowser, tee: dict[str, Any]
) -> None:
    response = await add(browser, tee["variants"][0]["id"], 2)

    set_cookie = response.headers["set-cookie"]
    assert response.status_code == 200
    assert "velo_cart=" in set_cookie and "HttpOnly" in set_cookie
    assert (await cart(browser))["item_count"] == 2
    async with new_browser() as stranger:
        assert (await cart(stranger))["items"] == []
    # Only a hash is stored: the database cannot hand out a working token.
    stored = await sql("SELECT guest_token FROM carts")
    assert stored != browser.client.cookies["velo_cart"] and len(stored) == 64


async def test_an_empty_cart_is_not_created_by_looking(browser: Browser) -> None:
    body = await cart(browser)

    assert body["id"] is None
    assert body["totals"]["total"] == {"amount": 0, "currency": "USD"}
    assert await sql("SELECT count(*) FROM carts") == 0


# ── A client cannot influence a price ─────────────────────────────────────────


async def test_a_price_in_the_request_is_refused(browser: Browser, tee: dict[str, Any]) -> None:
    response = await browser.post(
        "/api/v1/cart/items",
        json={"variant_id": tee["variants"][0]["id"], "quantity": 1, "price": 1},
    )

    assert response.status_code == 422
    assert response.json()["errors"][0]["field"].endswith("price")


async def test_prices_come_from_the_catalog(browser: Browser, tee: dict[str, Any]) -> None:
    body = (await add(browser, tee["variants"][0]["id"], 3)).json()

    item = body["items"][0]
    assert item["unit_price"] == {"amount": 2800, "currency": "USD"}
    assert item["line_total"] == {"amount": 8400, "currency": "USD"}
    assert body["totals"]["subtotal"]["amount"] == 8400
    assert body["totals"]["shipping"] is None  # no address: unknown, not zero
    assert body["totals"]["tax"] is None


# ── Lines ─────────────────────────────────────────────────────────────────────


async def test_adding_the_same_variant_again_adds_to_the_line(
    browser: Browser, tee: dict[str, Any]
) -> None:
    await add(browser, tee["variants"][0]["id"], 2)
    body = (await add(browser, tee["variants"][0]["id"], 3)).json()

    assert len(body["items"]) == 1
    assert body["items"][0]["quantity"] == 5


async def test_more_than_can_be_sold_is_refused(browser: Browser, tee: dict[str, Any]) -> None:
    await add(browser, tee["variants"][0]["id"], 8)

    response = await add(browser, tee["variants"][0]["id"], 3)

    assert (response.status_code, problem(response)) == (409, "quantity-unavailable")
    assert response.json()["errors"][0]["message"] == "At most 10."


async def test_quantities_change_and_zero_removes(browser: Browser, tee: dict[str, Any]) -> None:
    item_id = (await add(browser, tee["variants"][0]["id"], 2)).json()["items"][0]["id"]

    changed = (await browser.patch(f"/api/v1/cart/items/{item_id}", json={"quantity": 4})).json()
    removed = (await browser.patch(f"/api/v1/cart/items/{item_id}", json={"quantity": 0})).json()

    assert changed["items"][0]["quantity"] == 4
    assert removed["items"] == []


async def test_another_carts_line_is_not_found(
    browser: Browser, new_browser: NewBrowser, tee: dict[str, Any]
) -> None:
    item_id = (await add(browser, tee["variants"][0]["id"])).json()["items"][0]["id"]
    async with new_browser() as other:
        await add(other, tee["variants"][0]["id"])
        response = await other.delete(f"/api/v1/cart/items/{item_id}")

    assert response.status_code == 404


async def test_draft_products_cannot_be_added(admin: Browser, browser: Browser) -> None:
    draft = await product(admin, "Hidden", status="draft")

    response = await add(browser, draft["variants"][0]["id"])

    assert (response.status_code, problem(response)) == (409, "not-purchasable")


# ── Warnings, not silent changes ──────────────────────────────────────────────


async def test_a_price_change_is_flagged_until_the_line_is_touched(
    admin: Browser, browser: Browser, tee: dict[str, Any]
) -> None:
    item_id = (await add(browser, tee["variants"][0]["id"], 2)).json()["items"][0]["id"]
    await admin.patch(f"/api/v1/admin/variants/{tee['variants'][0]['id']}", json={"price": 3200})

    flagged = await cart(browser)
    touched = (await browser.patch(f"/api/v1/cart/items/{item_id}", json={"quantity": 2})).json()

    assert flagged["items"][0]["unit_price"]["amount"] == 3200  # always the current price
    assert flagged["warnings"][0]["code"] == "price_changed"
    assert flagged["warnings"][0]["previous_price"]["amount"] == 2800
    assert codes(touched) == []


async def test_an_unpublished_product_stays_but_is_not_charged(
    admin: Browser, browser: Browser, tee: dict[str, Any]
) -> None:
    other = await product(admin, "Other Tee", variants=[variant(price=1000)])
    await add(browser, tee["variants"][0]["id"])
    await add(browser, other["variants"][0]["id"])

    await admin.patch(f"/api/v1/admin/products/{tee['id']}", json={"status": "draft"})
    body = await cart(browser)

    assert len(body["items"]) == 2
    gone = next(item for item in body["items"] if item["variant"]["sku"] == "CT-1")
    assert gone["purchasable"] is False
    assert codes(body) == ["unavailable"]
    assert body["totals"]["total"]["amount"] == 1000


async def test_a_stock_shortfall_is_flagged(
    admin: Browser, browser: Browser, tee: dict[str, Any]
) -> None:
    await add(browser, tee["variants"][0]["id"], 6)
    await admin.post(
        f"/api/v1/admin/inventory/{tee['variants'][0]['id']}/adjust",
        json={"delta": -7, "reason": "damage"},
    )

    body = await cart(browser)

    assert body["items"][0]["availability"] == {"in_stock": True, "max_quantity": 3}
    assert codes(body) == ["insufficient_stock"]
    assert body["items"][0]["quantity"] == 6  # not silently reduced


# ── Discount codes ────────────────────────────────────────────────────────────


async def apply(browser: Browser, code: str) -> Any:
    return await browser.post("/api/v1/cart/discount", json={"code": code})


@pytest.mark.parametrize(
    ("row", "reason"),
    [
        ({}, "unknown"),
        (
            {
                "code": "OLD",
                "starts_at": datetime(2020, 1, 1, tzinfo=UTC),
                "ends_at": datetime(2020, 2, 1, tzinfo=UTC),
            },
            "expired",
        ),
        ({"code": "SOON", "starts_at": datetime(2999, 1, 1, tzinfo=UTC)}, "not_started"),
        ({"code": "GONE", "max_redemptions": 1, "times_redeemed": 1}, "used_up"),
        ({"code": "STAFF", "customer_segment": "staff"}, "not_eligible"),
        ({"code": "BIG", "min_subtotal_amount": 100_000}, "min_subtotal"),
    ],
)
async def test_a_code_that_cannot_be_used_says_why(
    browser: Browser, tee: dict[str, Any], row: dict[str, Any], reason: str
) -> None:
    if row:
        await discount(type="percentage", **row)
    await add(browser, tee["variants"][0]["id"])

    response = await apply(browser, row.get("code", "NOPE"))

    assert (response.status_code, problem(response)) == (422, "discount-code-invalid")
    assert response.json()["errors"][0]["code"] == reason
    assert (await cart(browser))["discount_code"] is None


async def test_a_code_applies_case_insensitively(browser: Browser, tee: dict[str, Any]) -> None:
    await discount(code="SAVE10", type="percentage", value=10)
    await add(browser, tee["variants"][0]["id"], 2)

    body = (await apply(browser, "save10")).json()

    assert body["discount"]["code"] == "SAVE10"
    assert body["totals"]["discount"]["amount"] == 560
    assert body["totals"]["total"]["amount"] == 5040


async def test_a_code_that_stops_applying_is_kept_and_flagged(
    browser: Browser, tee: dict[str, Any]
) -> None:
    await discount(code="OVER50", type="fixed_amount", value=1000, currency="USD",
                   min_subtotal_amount=5000)  # fmt: skip
    item_id = (await add(browser, tee["variants"][0]["id"], 2)).json()["items"][0]["id"]
    await apply(browser, "OVER50")

    lowered = (await browser.patch(f"/api/v1/cart/items/{item_id}", json={"quantity": 1})).json()
    raised = (await browser.patch(f"/api/v1/cart/items/{item_id}", json={"quantity": 2})).json()

    assert lowered["discount_code"] == "OVER50"
    assert lowered["totals"]["discount"]["amount"] == 0
    assert codes(lowered) == ["discount_not_applied"]
    assert raised["totals"]["discount"]["amount"] == 1000  # applies again by itself


async def test_first_order_codes_refuse_returning_customers(
    new_browser: NewBrowser, tee: dict[str, Any]
) -> None:
    await discount(code="WELCOME", type="percentage", first_order_only=True)
    async with new_browser() as customer:
        await sign_in_as(customer, "returning@example.com")
        await sql(
            """
            INSERT INTO orders (order_number, user_id, email, currency, status, subtotal_amount,
                                total_amount, shipping_address, billing_address)
            SELECT 'VLO-OLD1', id, email, 'USD', 'delivered', 100, 100, '{}', '{}'
            FROM users WHERE email = 'returning@example.com'
            """
        )
        await add(customer, tee["variants"][0]["id"])

        response = await apply(customer, "WELCOME")

    assert response.json()["errors"][0]["code"] == "first_order_only"


async def test_a_code_used_up_by_this_customer_is_refused(
    new_browser: NewBrowser, tee: dict[str, Any]
) -> None:
    await discount(code="ONCE", type="percentage", max_per_customer=1)
    async with new_browser() as customer:
        await sign_in_as(customer, "once@example.com")
        await sql(
            """
            WITH o AS (
                INSERT INTO orders (order_number, user_id, email, currency, status,
                                    subtotal_amount, total_amount, shipping_address,
                                    billing_address)
                SELECT 'VLO-ONCE', id, email, 'USD', 'paid', 100, 100, '{}', '{}'
                FROM users WHERE email = 'once@example.com' RETURNING id, user_id
            )
            INSERT INTO discount_redemptions (discount_id, order_id, user_id, amount)
            SELECT d.id, o.id, o.user_id, 10 FROM o, discounts d WHERE d.code = 'ONCE'
            """
        )
        await add(customer, tee["variants"][0]["id"])

        response = await apply(customer, "ONCE")

    assert response.json()["errors"][0]["code"] == "already_used"


async def test_subscriber_codes_follow_the_marketing_opt_in(
    new_browser: NewBrowser, tee: dict[str, Any]
) -> None:
    await discount(code="INSIDER", type="percentage", customer_segment="subscribers")
    async with new_browser() as subscriber, new_browser() as other:
        await sign_in_as(subscriber, "insider@example.com")
        await sql("UPDATE users SET marketing_opt_in = true WHERE email = 'insider@example.com'")
        await sign_in_as(other, "outsider@example.com")
        for shopper in (subscriber, other):
            await add(shopper, tee["variants"][0]["id"])

        allowed = await apply(subscriber, "INSIDER")
        refused = await apply(other, "INSIDER")

    assert allowed.status_code == 200
    assert refused.json()["errors"][0]["code"] == "not_eligible"


async def test_automatic_discounts_need_no_code_and_can_outclass_one(
    browser: Browser, tee: dict[str, Any]
) -> None:
    await discount(title="15% off over $50", type="percentage", value=15, min_subtotal_amount=5000)
    await discount(code="TEN", type="percentage", value=10)
    await add(browser, tee["variants"][0]["id"], 2)  # 5600

    automatic = await cart(browser)
    with_code = (await apply(browser, "TEN")).json()

    assert [d["title"] for d in automatic["discounts"]] == ["15% off over $50"]
    assert automatic["totals"]["discount"]["amount"] == 840
    assert with_code["discount_code"] == "TEN"
    assert with_code["discount"] is None  # the better automatic discount applies instead
    assert codes(with_code) == ["discount_outclassed"]
    assert with_code["totals"]["discount"]["amount"] == 840


async def test_stackable_discounts_combine(browser: Browser, tee: dict[str, Any]) -> None:
    await discount(title="Stack 10%", type="percentage", value=10, is_stackable=True)
    await discount(code="STACK5", type="fixed_amount", value=500, currency="USD", is_stackable=True)
    await add(browser, tee["variants"][0]["id"], 2)  # 5600

    body = (await apply(browser, "STACK5")).json()

    assert body["totals"]["discount"]["amount"] == 560 + 500
    assert {d["type"] for d in body["discounts"]} == {"percentage", "fixed_amount"}


async def test_buy_x_get_y_through_the_api(admin: Browser, browser: Browser) -> None:
    sock = await product(admin, "Sock", variants=[variant(price=1000, stock=50)])
    await discount(code="B2G1", type="buy_x_get_y", value=100, buy_quantity=2, get_quantity=1)
    await add(browser, sock["variants"][0]["id"], 6)

    body = (await apply(browser, "B2G1")).json()

    assert body["totals"]["discount"]["amount"] == 2000  # two of six free
    assert body["totals"]["total"]["amount"] == 4000


async def test_removing_the_code_removes_its_discount(
    browser: Browser, tee: dict[str, Any]
) -> None:
    await discount(code="GONE10", type="percentage", value=10)
    await add(browser, tee["variants"][0]["id"])
    await apply(browser, "GONE10")

    body = (await browser.delete("/api/v1/cart/discount")).json()

    assert (body["discount_code"], body["totals"]["discount"]["amount"]) == (None, 0)


async def test_guessing_codes_is_rate_limited(browser: Browser, tee: dict[str, Any]) -> None:
    await add(browser, tee["variants"][0]["id"])
    statuses = [(await apply(browser, f"GUESS{n}")).status_code for n in range(21)]

    assert statuses[:20] == [422] * 20
    assert statuses[20] == 429


# ── Shipping and tax estimates ────────────────────────────────────────────────


async def test_an_address_estimates_shipping_and_tax(browser: Browser, tee: dict[str, Any]) -> None:
    await shipping_and_tax()
    await add(browser, tee["variants"][0]["id"], 2)  # 5600

    body = await cart(browser, **US_CA)

    assert [o["name"] for o in body["shipping"]["options"]] == ["Standard", "Express"]
    assert body["totals"]["shipping"]["amount"] == 599
    assert body["totals"]["tax"]["amount"] == 406  # 7.25% of 5600
    assert body["totals"]["total"]["amount"] == 5600 + 599 + 406


async def test_a_chosen_rate_and_the_free_threshold(browser: Browser, tee: dict[str, Any]) -> None:
    await shipping_and_tax()
    await add(browser, tee["variants"][0]["id"], 3)  # 8400: over the free threshold

    free = await cart(browser, **US_CA)
    express_id = next(o["id"] for o in free["shipping"]["options"] if o["name"] == "Express")
    express = await cart(browser, **US_CA, shipping_rate=express_id)

    assert free["totals"]["shipping"]["amount"] == 0
    assert express["totals"]["shipping"]["amount"] == 1499


async def test_an_address_we_do_not_ship_to_is_flagged(
    browser: Browser, tee: dict[str, Any]
) -> None:
    await shipping_and_tax()
    await add(browser, tee["variants"][0]["id"])

    body = await cart(browser, country="JP")

    assert body["totals"]["shipping"] is None
    assert body["totals"]["tax"] == {"amount": 0, "currency": "USD"}  # known: none applies
    assert codes(body) == ["no_shipping"]


# ── Merge on sign-in ──────────────────────────────────────────────────────────


async def test_signing_in_merges_the_guest_cart(
    admin: Browser, new_browser: NewBrowser, tee: dict[str, Any]
) -> None:
    other = await product(admin, "Merge Cap", variants=[variant(price=1500, stock=5)])
    await discount(code="GUEST10", type="percentage", value=10)
    async with new_browser() as shopper:
        await sign_in_as(shopper, "merger@example.com")
        await add(shopper, tee["variants"][0]["id"], 4)  # the account's cart
        await shopper.post("/api/v1/auth/logout")

        await add(shopper, tee["variants"][0]["id"], 9)  # as a guest: 4 + 9 > 10 in stock
        await add(shopper, other["variants"][0]["id"], 2)
        await apply(shopper, "GUEST10")
        guest_token = shopper.client.cookies["velo_cart"]
        login = await shopper.post(
            "/api/v1/auth/login", json={"email": "merger@example.com",
                                        "password": "tangerine-ocelot-harbour"},
        )  # fmt: skip
        merged = await cart(shopper)

    quantities = {item["variant"]["sku"]: item["quantity"] for item in merged["items"]}
    assert login.status_code == 200
    assert "velo_cart=" in login.headers.get("set-cookie", "")  # cleared
    assert quantities == {"CT-1": 10, other["variants"][0]["sku"]: 2}  # capped at stock
    assert merged["discount_code"] == "GUEST10"  # the account had none
    assert (
        await sql("SELECT status FROM carts WHERE guest_token IS NULL AND status = 'merged'")
        == "merged"
    )
    assert guest_token not in str(
        await sql("SELECT string_agg(coalesce(guest_token,''), ',') FROM carts")
    )


async def test_registering_keeps_the_guest_cart(browser: Browser, tee: dict[str, Any]) -> None:
    await add(browser, tee["variants"][0]["id"], 2)

    await browser.post(
        "/api/v1/auth/register",
        json={"email": "newcomer@example.com", "password": "tangerine-ocelot-harbour"},
    )
    body = await cart(browser)

    assert body["item_count"] == 2
    assert (
        await sql(
            "SELECT count(*) FROM carts c JOIN users u ON u.id = c.user_id "
            "WHERE u.email = 'newcomer@example.com' AND c.status = 'active'"
        )
        == 1
    )


async def test_merge_without_a_guest_cart_is_harmless(new_browser: NewBrowser) -> None:
    async with new_browser() as shopper:
        await sign_in_as(shopper, "nomerge@example.com")
        response = await shopper.post("/api/v1/cart/merge")

    assert response.status_code == 200
    assert response.json()["items"] == []


# ── Limits and housekeeping ───────────────────────────────────────────────────


async def test_cart_changes_are_rate_limited(browser: Browser, tee: dict[str, Any]) -> None:
    # The first add creates the cart (counted against the IP); later changes count per cart.
    item_id = (await add(browser, tee["variants"][0]["id"])).json()["items"][0]["id"]
    statuses = [
        (await browser.patch(f"/api/v1/cart/items/{item_id}", json={"quantity": 1})).status_code
        for _ in range(61)
    ]

    assert statuses[:60] == [200] * 60
    assert statuses[60] == 429


async def test_idle_carts_are_marked_abandoned_and_come_back(
    browser: Browser, tee: dict[str, Any], live_app: Any
) -> None:
    from velo.db.session import session_scope
    from velo.domains.cart.service import CartSweeper

    item_id = (await add(browser, tee["variants"][0]["id"])).json()["items"][0]["id"]
    await sql("UPDATE carts SET updated_at = now() - interval '2 days'")
    async with session_scope() as session:
        from datetime import timedelta

        swept = await CartSweeper(session).sweep(abandon_after=timedelta(hours=24))
    abandoned = await sql("SELECT status FROM carts")

    await browser.patch(f"/api/v1/cart/items/{item_id}", json={"quantity": 2})

    assert swept["abandoned"] == 1
    assert abandoned == "abandoned"
    assert await sql("SELECT status FROM carts") == "active"
    assert await sql("SELECT abandoned_at FROM carts") is None


async def test_expired_guest_carts_are_deleted(
    browser: Browser, tee: dict[str, Any], live_app: Any
) -> None:
    from datetime import timedelta

    from velo.db.session import session_scope
    from velo.domains.cart.service import CartSweeper

    await add(browser, tee["variants"][0]["id"])
    await sql("UPDATE carts SET expires_at = now() - interval '1 minute'")
    async with session_scope() as session:
        swept = await CartSweeper(session).sweep(abandon_after=timedelta(hours=24))

    assert swept["expired"] == 1
    assert (await cart(browser))["items"] == []


# ── The rules-based tax provider ──────────────────────────────────────────────


async def test_tax_rates_match_by_region_and_postcode_and_priority(live_app: Any) -> None:
    from velo.db.session import session_scope
    from velo.domains.shipping.service import Address, RulesTaxProvider

    await sql(
        """
        INSERT INTO tax_rates (name, country_code, region, postal_prefix, rate, priority) VALUES
          ('State', 'US', 'CA', NULL, 0.0600, 0),
          ('County', 'US', 'CA', NULL, 0.0125, 0),
          ('Special district', 'US', 'CA', '941', 0.0900, 1),
          ('Other state', 'US', 'NY', NULL, 0.0400, 0),
          ('Inactive', 'US', 'CA', NULL, 0.5000, 0)
        """
    )
    await sql("UPDATE tax_rates SET is_active = false WHERE name = 'Inactive'")
    async with session_scope() as session:
        provider = RulesTaxProvider(session)
        la = await provider.rules_for(Address("us", "ca", "90012"))
        sf = await provider.rules_for(Address("US", "CA", "94103"))
        texas = await provider.rules_for(Address("US", "TX", "73301"))

    assert sorted(rule.name for rule in la) == ["County", "State"]  # same priority: both
    assert [rule.name for rule in sf] == ["Special district"]  # a higher priority replaces
    assert texas == []
