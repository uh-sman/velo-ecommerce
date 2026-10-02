"""The admin API (PLANNING.md Phase 11): customers, discounts, settings, staff, audit, analytics.

The Definition of Done for the API half: an operator with no SQL access can
run the store — and each of these is reachable only with the right
permission.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi import FastAPI

from tests.integration.catalog_support import problem, product, sql, variant
from tests.integration.checkout_support import FakeStripe, providers_for
from tests.integration.conftest import STAFF_PASSWORD, Browser, sign_in_as
from tests.integration.test_cart import add
from tests.integration.test_checkout import checkout_ready, paid
from tests.integration.test_checkout import lamp as lamp
from velo.core.email import InMemoryMailer
from velo.domains.payments.registry import PaymentProviders

pytestmark = pytest.mark.integration

NewBrowser = Callable[[], AbstractAsyncContextManager[Browser]]


@pytest.fixture
def stripe() -> FakeStripe:
    return FakeStripe()


@pytest.fixture
async def providers(live_app: FastAPI, stripe: FakeStripe) -> PaymentProviders:
    from velo.api.deps import get_payment_providers

    configured = providers_for(stripe)
    live_app.dependency_overrides[get_payment_providers] = lambda: configured
    return configured


@pytest.fixture
async def owner(new_browser: NewBrowser) -> Any:
    async with new_browser() as instance:
        yield await sign_in_as(instance, "owner@example.com", "owner")


def err(response: Any) -> tuple[int, str]:
    return response.status_code, problem(response)


# ── Who may do what ───────────────────────────────────────────────────────────


async def test_me_reports_the_role_and_its_permissions(
    admin: Browser, new_browser: NewBrowser
) -> None:
    me = (await admin.get("/api/v1/admin/me")).json()
    assert me["role"] == "admin"
    assert "orders:refund" in me["permissions"] and "audit:read" in me["permissions"]
    assert "staff:manage" not in me["permissions"]
    async with new_browser() as customer:
        await sign_in_as(customer, "c@example.com")
        assert (await customer.get("/api/v1/admin/me")).status_code == 403


async def test_each_area_needs_its_permission(new_browser: NewBrowser) -> None:
    async with new_browser() as picker:
        await sign_in_as(picker, "picker@example.com", "fulfilment")
        for path in (
            "/api/v1/admin/customers",
            "/api/v1/admin/discounts",
            "/api/v1/admin/settings",
            "/api/v1/admin/staff",
            "/api/v1/admin/audit-log",
            "/api/v1/admin/analytics/summary",
        ):
            assert (await picker.get(path)).status_code == 403, path


# ── Customers ─────────────────────────────────────────────────────────────────


async def test_customers_with_lifetime_value_and_notes(
    admin: Browser,
    new_browser: NewBrowser,
    stripe: FakeStripe,
    providers: PaymentProviders,
    lamp: dict[str, Any],
) -> None:
    async with new_browser() as grace:
        await sign_in_as(grace, "grace@example.com")
        checkout_id = await checkout_ready(grace, lamp, 1)
        await paid(grace, stripe, providers, checkout_id)

    listed = await admin.get("/api/v1/admin/customers", params={"q": "grace"})
    assert listed.status_code == 200, listed.text
    (row,) = listed.json()["data"]
    assert row["order_count"] == 1
    assert row["lifetime_value"] == {"amount": 5000 + 599 + 363, "currency": "USD"}

    note = await admin.post(
        f"/api/v1/admin/customers/{row['id']}/notes", json={"body": "Prefers morning delivery."}
    )
    assert note.status_code == 201
    detail = (await admin.get(f"/api/v1/admin/customers/{row['id']}")).json()
    assert detail["notes"][0]["body"] == "Prefers morning delivery."
    assert detail["notes"][0]["author_email"] == "admin@example.com"
    assert len(detail["recent_orders"]) == 1


# ── Discounts ─────────────────────────────────────────────────────────────────


SPRING = {"code": "spring20", "title": "Spring sale", "type": "percentage", "value": "20"}


async def test_create_validate_and_retire_discounts(admin: Browser) -> None:
    created = await admin.post("/api/v1/admin/discounts", json=SPRING)
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["code"] == "SPRING20" and body["status"] == "active"

    duplicate = await admin.post("/api/v1/admin/discounts", json={**SPRING, "title": "Again"})
    assert err(duplicate) == (409, "conflict")
    bad = await admin.post(
        "/api/v1/admin/discounts", json={"title": "Too much", "type": "percentage", "value": "150"}
    )
    assert bad.status_code == 422
    no_currency = await admin.post(
        "/api/v1/admin/discounts", json={"title": "$5", "type": "fixed_amount", "value": "500"}
    )
    assert no_currency.status_code == 422

    later = await admin.patch(
        f"/api/v1/admin/discounts/{body['id']}",
        json={"starts_at": (datetime.now(UTC) + timedelta(days=3)).isoformat()},
    )
    assert later.json()["status"] == "scheduled"

    # Used once: its terms are fixed, and retiring it deactivates rather than deletes.
    await sql("UPDATE discounts SET times_redeemed = 1 WHERE id = :id", id=body["id"])
    locked = await admin.patch(f"/api/v1/admin/discounts/{body['id']}", json={"value": "30"})
    assert err(locked) == (409, "conflict")
    retired = await admin.delete(f"/api/v1/admin/discounts/{body['id']}")
    assert retired.json() == {"outcome": "deactivated"}
    assert (await admin.get(f"/api/v1/admin/discounts/{body['id']}")).json()["status"] == "inactive"

    unused = (
        await admin.post(
            "/api/v1/admin/discounts",
            json={"title": "Free ship", "type": "free_shipping", "code": "SHIPFREE"},
        )
    ).json()
    assert (await admin.delete(f"/api/v1/admin/discounts/{unused['id']}")).json() == {
        "outcome": "deleted"
    }


async def test_the_tester_prices_a_basket_like_checkout_would(
    admin: Browser,
    new_browser: NewBrowser,
    stripe: FakeStripe,
    providers: PaymentProviders,
    lamp: dict[str, Any],
) -> None:
    draft = {**SPRING, "min_subtotal_amount": 8000}
    small = await admin.post(
        "/api/v1/admin/discounts/preview",
        json={"discount": draft, "lines": [{"variant_id": lamp["id"], "quantity": 1}]},
    )
    assert small.status_code == 200, small.text
    assert small.json()["eligible"] is False and small.json()["cart_problem"] == "min_subtotal"

    big = (
        await admin.post(
            "/api/v1/admin/discounts/preview",
            json={"discount": draft, "lines": [{"variant_id": lamp["id"], "quantity": 2}]},
        )
    ).json()
    assert big["eligible"] is True
    assert big["subtotal"] == 10000 and big["discount"] == 2000 and big["total"] == 8000

    # Customer rules: a first-order code, tried for someone who has ordered.
    async with new_browser() as ada:
        await sign_in_as(ada, "ada@example.com")
        checkout_id = await checkout_ready(ada, lamp, 1)
        await paid(ada, stripe, providers, checkout_id)
    returning = (
        await admin.post(
            "/api/v1/admin/discounts/preview",
            json={
                "discount": {**SPRING, "first_order_only": True},
                "lines": [{"variant_id": lamp["id"], "quantity": 1}],
                "customer_email": "ada@example.com",
            },
        )
    ).json()
    assert returning["eligible"] is False
    assert returning["customer_problem"] == "That code is for a first order only."
    # Nothing was created by testing.
    assert await sql("SELECT count(*) FROM discounts") == 0


# ── Settings, shipping, tax ───────────────────────────────────────────────────


async def test_store_settings_and_providers_never_show_a_key(
    owner: Browser, admin: Browser
) -> None:
    assert (await admin.get("/api/v1/admin/settings")).status_code == 403  # owners only
    settings = (await owner.get("/api/v1/admin/settings")).json()
    assert settings["store"]["currency"] == "USD"
    assert {p["name"] for p in settings["payment_providers"]} == {"stripe", "paystack"}
    assert "sk_" not in str(settings) and "whsec" not in str(settings)

    updated = await owner.patch(
        "/api/v1/admin/settings/store", json={"name": "Velo Goods", "phone": "+1 555 0100"}
    )
    assert updated.status_code == 200 and updated.json()["name"] == "Velo Goods"
    sneaky = await owner.patch("/api/v1/admin/settings/store", json={"currency": "EUR"})
    assert sneaky.status_code == 422  # not a field that can be sent
    emails = await owner.patch(
        "/api/v1/admin/settings/emails", json={"signature": "Love, the Velo crew"}
    )
    assert emails.json()["signature"] == "Love, the Velo crew"
    again = (await owner.get("/api/v1/admin/settings")).json()
    assert again["store"]["name"] == "Velo Goods" and again["store"]["currency"] == "USD"


async def test_zones_rates_and_tax_drive_checkout(owner: Browser, browser: Browser) -> None:
    zone = await owner.post(
        "/api/v1/admin/shipping-zones", json={"name": "Canada", "country_codes": ["ca"]}
    )
    assert zone.status_code == 201, zone.text
    assert zone.json()["country_codes"] == ["CA"]
    rate = await owner.post(
        f"/api/v1/admin/shipping-zones/{zone.json()['id']}/rates",
        json={
            "name": "Canada Post",
            "price_amount": 1200,
            "currency": "USD",
            "est_days_min": 4,
            "est_days_max": 8,
        },
    )
    assert rate.status_code == 201, rate.text
    bad = await owner.patch(
        f"/api/v1/admin/shipping-rates/{rate.json()['id']}",
        json={"est_days_min": 9, "est_days_max": 2},
    )
    assert bad.status_code == 422
    tax = await owner.post(
        "/api/v1/admin/tax-rates",
        json={"name": "GST", "country_code": "ca", "rate": "0.05"},
    )
    assert tax.status_code == 201 and tax.json()["country_code"] == "CA"
    too_high = await owner.post(
        "/api/v1/admin/tax-rates", json={"name": "Oops", "country_code": "CA", "rate": "5"}
    )
    assert too_high.status_code == 422

    # The storefront sees them at once.
    made = await product(owner, "Canoe Paddle", variants=[variant(price=4000)])
    await add(browser, made["variants"][0]["id"], 1)
    cart = (
        await browser.get("/api/v1/cart", params={"country": "CA", "postal_code": "K1A0B1"})
    ).json()
    assert [o["name"] for o in cart["shipping"]["options"]] == ["Canada Post"]
    assert cart["totals"]["tax"]["amount"] == 200  # 5% of $40.00


# ── Staff ─────────────────────────────────────────────────────────────────────


async def test_invite_accept_change_and_revoke(
    owner: Browser, new_browser: NewBrowser, mailer: InMemoryMailer
) -> None:
    invited = await owner.post(
        "/api/v1/admin/staff/invite", json={"email": "new.hire@example.com", "role": "staff"}
    )
    assert invited.status_code == 201, invited.text
    email = next(m for m in mailer.outbox if m.to == "new.hire@example.com")
    token = re.search(r"accept-invite\?token=([\w-]+)", email.text)
    assert token
    team = (await owner.get("/api/v1/admin/staff")).json()
    assert [i["email"] for i in team["invitations"]] == ["new.hire@example.com"]

    async with new_browser() as hire:
        accepted = await hire.post(
            "/api/v1/staff-invitations/accept",
            json={"token": token.group(1), "password": STAFF_PASSWORD, "first_name": "Nia"},
        )
        assert accepted.status_code == 204, accepted.text
        reused = await hire.post(
            "/api/v1/staff-invitations/accept",
            json={"token": token.group(1), "password": STAFF_PASSWORD},
        )
        assert err(reused) == (422, "invitation-invalid")
        login = await hire.post(
            "/api/v1/auth/login",
            json={"email": "new.hire@example.com", "password": STAFF_PASSWORD},
        )
        assert login.status_code == 200
        assert (await hire.get("/api/v1/admin/me")).json()["role"] == "staff"

        member = next(
            m
            for m in (await owner.get("/api/v1/admin/staff")).json()["members"]
            if m["email"] == "new.hire@example.com"
        )
        promoted = await owner.patch(f"/api/v1/admin/staff/{member['id']}", json={"role": "admin"})
        assert promoted.json()["role"] == "admin"
        revoked = await owner.patch(
            f"/api/v1/admin/staff/{member['id']}", json={"role": "customer"}
        )
        assert revoked.status_code == 200
        # Every session ended: the old access token stops at its next refresh.
        assert (await hire.post("/api/v1/auth/refresh")).status_code == 401


async def test_the_last_owner_cannot_be_removed(owner: Browser) -> None:
    me = (await owner.get("/api/v1/admin/me")).json()
    self_demote = await owner.patch(f"/api/v1/admin/staff/{me['id']}", json={"role": "admin"})
    assert err(self_demote) == (409, "last-owner")


# ── Audit, saved views, analytics ─────────────────────────────────────────────


async def test_the_audit_log_shows_who_did_what(admin: Browser) -> None:
    await admin.post("/api/v1/admin/discounts", json=SPRING)
    log = await admin.get("/api/v1/admin/audit-log", params={"action": "discount."})
    assert log.status_code == 200
    (entry,) = log.json()["data"]
    assert entry["action"] == "discount.created"
    assert entry["actor_email"] == "admin@example.com"
    by_other = await admin.get("/api/v1/admin/audit-log", params={"actor": "nobody@example.com"})
    assert by_other.json()["data"] == []


async def test_saved_views_are_personal(admin: Browser, owner: Browser) -> None:
    saved = await admin.post(
        "/api/v1/admin/saved-views",
        json={"scope": "orders", "name": "To ship", "query": {"fulfilment_status": "unfulfilled"}},
    )
    assert saved.status_code == 201
    twice = await admin.post(
        "/api/v1/admin/saved-views", json={"scope": "orders", "name": "To ship", "query": {}}
    )
    assert twice.status_code == 409
    mine = (await admin.get("/api/v1/admin/saved-views", params={"scope": "orders"})).json()
    assert [v["name"] for v in mine] == ["To ship"]
    theirs = (await owner.get("/api/v1/admin/saved-views", params={"scope": "orders"})).json()
    assert theirs == []
    assert (
        await owner.delete(f"/api/v1/admin/saved-views/{saved.json()['id']}")
    ).status_code == 404
    assert (
        await admin.delete(f"/api/v1/admin/saved-views/{saved.json()['id']}")
    ).status_code == 204


async def test_analytics_report_what_was_sold(
    admin: Browser,
    browser: Browser,
    stripe: FakeStripe,
    providers: PaymentProviders,
    lamp: dict[str, Any],
) -> None:
    checkout_id = await checkout_ready(browser, lamp, 2)
    done = await paid(browser, stripe, providers, checkout_id)
    total = await sql(
        "SELECT total_amount FROM orders WHERE order_number = :n", n=done["order_number"]
    )

    summary = (await admin.get("/api/v1/admin/analytics/summary")).json()
    assert summary["revenue"] == total and summary["orders"] == 1
    assert summary["average_order_value"] == total and summary["units"] == 2

    series = (await admin.get("/api/v1/admin/analytics/revenue", params={"interval": "day"})).json()
    assert len(series) >= 30 and sum(p["revenue"] for p in series) == total
    csv = await admin.get("/api/v1/admin/analytics/revenue", params={"format": "csv"})
    assert csv.headers["content-type"].startswith("text/csv")
    assert csv.text.splitlines()[0] == "period,revenue_minor_units,orders"

    (top,) = (await admin.get("/api/v1/admin/analytics/products")).json()
    assert top["title"] == "Desk Lamp" and top["units"] == 2

    funnel = {
        s["step"]: s["count"] for s in (await admin.get("/api/v1/admin/analytics/funnel")).json()
    }
    assert funnel == {"carts": 1, "checkouts": 1, "payments": 1, "orders": 1}

    cohorts = (await admin.get("/api/v1/admin/analytics/cohorts", params={"months": 3})).json()
    assert cohorts[-1]["customers"] == 1 and cohorts[-1]["retained"] == []

    window = await admin.get(
        "/api/v1/admin/analytics/summary",
        params={"since": "2026-01-02T00:00:00Z", "until": "2026-01-01T00:00:00Z"},
    )
    assert window.status_code == 422
