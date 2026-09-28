"""Stock, the ledger, alerts, back-in-stock, and CSV import (PLANNING.md Phase 6.1-6.2)."""

from __future__ import annotations

from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from typing import Any

import pytest

from tests.integration.catalog_support import pages, problem, product, sql, variant
from tests.integration.conftest import Browser, drain, sign_in_as
from velo.core.email import InMemoryMailer

pytestmark = pytest.mark.integration

NewBrowser = Callable[[], AbstractAsyncContextManager[Browser]]


async def adjust(admin: Browser, variant_id: str, delta: int, reason: str, **extra: Any) -> Any:
    return await admin.post(
        f"/api/v1/admin/inventory/{variant_id}/adjust",
        json={"delta": delta, "reason": reason, **extra},
    )


# ── Adjustments and the ledger ────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("delta", "reason", "slug"),
    [
        (-1, "restock", "invalid-adjustment"),  # a restock adds
        (1, "damage", "invalid-adjustment"),  # damage removes
        (0, "adjustment", "invalid-adjustment"),
    ],
)
async def test_an_adjustment_must_fit_its_reason(
    admin: Browser, delta: int, reason: str, slug: str
) -> None:
    created = await product(admin, "Reason Tee", variants=[variant(stock=10)])

    response = await adjust(admin, created["variants"][0]["id"], delta, reason)

    assert (response.status_code, problem(response)) == (422, slug)


async def test_a_reason_is_required(admin: Browser) -> None:
    created = await product(admin, "No Reason Tee")
    variant_id = created["variants"][0]["id"]

    missing = await admin.post(f"/api/v1/admin/inventory/{variant_id}/adjust", json={"delta": 1})
    invented = await adjust(admin, variant_id, -1, "sale")  # checkout's reason, not an operator's

    assert missing.status_code == 422
    assert invented.status_code == 422


async def test_stock_cannot_go_below_zero_or_below_what_is_reserved(admin: Browser) -> None:
    created = await product(admin, "Reserved Tee", variants=[variant(stock=10)])
    variant_id = created["variants"][0]["id"]
    await sql(
        "UPDATE inventory_items SET quantity_reserved = 4 WHERE variant_id = CAST(:id AS uuid)",
        id=variant_id,
    )

    below_zero = await adjust(admin, variant_id, -11, "damage")
    below_reserved = await adjust(admin, variant_id, -7, "damage")
    allowed = await adjust(admin, variant_id, -6, "damage")

    assert (below_zero.status_code, problem(below_zero)) == (409, "insufficient-stock")
    assert (below_reserved.status_code, problem(below_reserved)) == (409, "insufficient-stock")
    assert allowed.json()["stock"] == {
        "quantity_on_hand": 4,
        "quantity_reserved": 4,
        "available": 0,
        "reorder_point": 5,
        "track_inventory": True,
        "allow_backorder": False,
    }


async def test_the_ledger_always_sums_to_stock_on_hand(admin: Browser) -> None:
    created = await product(admin, "Ledger Tee", variants=[variant(stock=20)])
    variant_id = created["variants"][0]["id"]
    for delta, reason in ((5, "restock"), (-2, "damage"), (-1, "theft"), (3, "adjustment")):
        assert (await adjust(admin, variant_id, delta, reason, note="count")).status_code == 200

    movements = await pages(admin, f"/api/v1/admin/inventory/{variant_id}/movements", limit=2)
    on_hand = await sql(
        "SELECT quantity_on_hand FROM inventory_items WHERE variant_id = CAST(:id AS uuid)",
        id=variant_id,
    )

    assert [m["reason"] for m in movements] == [
        "adjustment", "theft", "damage", "restock", "initial",
    ]  # fmt: skip
    assert sum(m["quantity_delta"] for m in movements) == on_hand == 25
    assert all(m["actor_id"] for m in movements)


async def test_the_inventory_list_flags_low_stock(admin: Browser) -> None:
    await product(admin, "Plenty Tee", variants=[variant(sku="PLENTY-1", stock=40)])
    await product(admin, "Scarce Tee", variants=[variant(sku="SCARCE-1", stock=2)])

    low = (await admin.get("/api/v1/admin/inventory", params={"low_stock": "true"})).json()
    found = (await admin.get("/api/v1/admin/inventory", params={"q": "plenty"})).json()

    assert [row["sku"] for row in low["data"]] == ["SCARCE-1"]
    assert low["data"][0]["low_stock"] is True
    assert [row["sku"] for row in found["data"]] == ["PLENTY-1"]


# ── Alerts and back in stock (through the worker) ─────────────────────────────


async def test_crossing_the_reorder_point_alerts_once(
    admin: Browser, worker_ctx: dict[str, Any], mailer: InMemoryMailer
) -> None:
    created = await product(admin, "Alert Tee", variants=[variant(sku="ALERT-1", stock=10)])
    variant_id = created["variants"][0]["id"]

    await adjust(admin, variant_id, -6, "damage")  # 10 -> 4: crosses 5
    await adjust(admin, variant_id, -1, "damage")  # 4 -> 3: already low
    await drain(worker_ctx)

    alerts = [m for m in mailer.outbox if m.subject == "Low stock: ALERT-1"]
    assert len(alerts) == 1
    assert alerts[0].to == "ops@example.com"
    assert "down to 4 available" in alerts[0].text


async def test_back_in_stock_notifies_each_subscriber_once(
    admin: Browser,
    new_browser: NewBrowser,
    worker_ctx: dict[str, Any],
    mailer: InMemoryMailer,
) -> None:
    created = await product(
        admin,
        "Waitlist Tee",
        variants=[variant(stock=0, options={"Size": "M"}), variant(stock=3, options={"Size": "L"})],
    )
    medium = next(v for v in created["variants"] if v["option_values"]["Size"] == "M")
    large = next(v for v in created["variants"] if v["option_values"]["Size"] == "L")
    path = "/api/v1/products/waitlist-tee/back-in-stock"
    async with new_browser() as anonymous, new_browser() as member:
        await sign_in_as(member, "member@example.com")

        in_stock = await anonymous.post(
            path, json={"variant_id": large["id"], "email": "a@example.com"}
        )
        no_email = await anonymous.post(path, json={"variant_id": medium["id"]})
        first = await anonymous.post(
            path, json={"variant_id": medium["id"], "email": "a@example.com"}
        )
        again = await anonymous.post(
            path, json={"variant_id": medium["id"], "email": "A@example.com"}
        )
        by_account = await member.post(path, json={"variant_id": medium["id"]})

    await adjust(admin, medium["id"], 5, "restock")
    await drain(worker_ctx)
    await adjust(admin, medium["id"], -5, "adjustment")  # sold out again
    await adjust(admin, medium["id"], 5, "restock")  # back again: no second email
    await drain(worker_ctx)

    assert (in_stock.status_code, problem(in_stock)) == (409, "already-in-stock")
    assert no_email.status_code == 422
    assert first.status_code == again.status_code == by_account.status_code == 202
    sent = sorted(m.to for m in mailer.outbox if m.subject == "Back in stock: Waitlist Tee")
    assert sent == ["a@example.com", "member@example.com"]


# ── CSV import and export ─────────────────────────────────────────────────────

GOOD_CSV = (
    "product_slug,title,brand,status,sku,price,compare_at,option1_name,option1_value,stock\n"
    "csv-socks,Wool Socks,Northbound,active,SOCK-S,14.00,,Size,S,30\n"
    "csv-socks,,,,SOCK-M,14.00,18.50,Size,M,0\n"
)


async def import_csv(admin: Browser, body: str, *, dry_run: bool) -> Any:
    return await admin.post(
        "/api/v1/admin/products/bulk-import",
        params={"dry_run": str(dry_run).lower()},
        content=body.encode(),
        headers={"Content-Type": "text/csv"},
    )


async def test_a_dry_run_reports_the_plan_and_writes_nothing(
    admin: Browser, browser: Browser
) -> None:
    response = await import_csv(admin, GOOD_CSV, dry_run=True)

    assert response.json() | {"errors": []} == {
        "dry_run": True,
        "applied": False,
        "rows": 2,
        "products_created": 1,
        "products_updated": 0,
        "variants_created": 2,
        "variants_updated": 0,
        "errors": [],
    }
    assert (await browser.get("/api/v1/products/csv-socks")).status_code == 404


async def test_an_import_applies_and_a_reimport_updates(admin: Browser, browser: Browser) -> None:
    await import_csv(admin, GOOD_CSV, dry_run=False)
    await import_csv(admin, GOOD_CSV.replace("SOCK-S,14.00", "SOCK-S,12.50"), dry_run=False)

    detail = (await browser.get("/api/v1/products/csv-socks")).json()
    prices = {v["sku"]: (v["price"]["amount"], v["compare_at"]) for v in detail["variants"]}

    assert prices == {
        "SOCK-S": (1250, None),
        "SOCK-M": (1400, {"amount": 1850, "currency": "USD"}),
    }
    assert detail["brand"] == "Northbound"


async def test_every_bad_row_is_reported_and_nothing_is_written(
    admin: Browser, browser: Browser
) -> None:
    bad = (
        "product_slug,title,sku,price,compare_at,option1_name,option1_value,status\n"
        "bad-csv,Bad,BAD-1,12.999,,Size,M,active\n"
        "bad-csv,,BAD-1,abc,5,Size,,live\n"
        "good-csv,Good,GOOD-1,10.00,,,,active\n"
    )

    report = (await import_csv(admin, bad, dry_run=False)).json()

    problems = {(e["row"], e["column"]) for e in report["errors"]}
    assert report["applied"] is False
    assert problems == {
        (2, "price"),  # three decimal places
        (3, "price"),  # not a number
        (3, "status"),
        (3, "option1_value"),  # a name without a value
        (3, "sku"),  # duplicate of row 2
    }
    assert (await browser.get("/api/v1/products/good-csv")).status_code == 404  # all or nothing


async def test_an_import_rejects_unknown_columns(admin: Browser) -> None:
    response = await import_csv(
        admin, "product_slug,sku,price,colour\nx,Y,1.00,red\n", dry_run=True
    )

    assert response.status_code == 422
    assert "Unknown columns: colour" in response.json()["detail"]


async def test_the_export_round_trips(admin: Browser, browser: Browser) -> None:
    await import_csv(admin, GOOD_CSV, dry_run=False)
    exported = await admin.get("/api/v1/admin/products/export")
    await admin.delete(
        f"/api/v1/admin/products/{(await browser.get('/api/v1/products/csv-socks')).json()['id']}"
    )

    reimport = (
        await import_csv(
            admin,
            exported.text.replace("csv-socks", "csv-socks-copy").replace("SOCK-", "COPY-"),
            dry_run=False,
        )
    ).json()

    assert exported.headers["content-type"].startswith("text/csv")
    assert "SOCK-M,M,Size,M,,,,,14.00,18.50" in exported.text
    assert reimport["applied"] is True
    assert reimport["variants_created"] == 2
