"""Orders, fulfilment, refunds and returns end to end (PLANNING.md Phase 9).

The Definition of Done, as tests: an operator takes an order from paid to
delivered, processes a partial return, and issues a partial refund — entirely
through the API — and every transition is in the audit trail. Orders are
created the production way: a checkout, a signed webhook, the worker's
processor. Refunds go through the real Stripe adapter to the fake Stripe.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from datetime import timedelta
from typing import Any

import pytest
from fastapi import FastAPI

from tests.integration.catalog_support import problem, sql
from tests.integration.checkout_support import FakeStripe, key, providers_for
from tests.integration.conftest import Browser, drain, sign_in_as
from tests.integration.test_checkout import checkout_ready, paid, stock
from tests.integration.test_checkout import lamp as lamp
from velo.core.email import InMemoryMailer
from velo.db.session import open_session
from velo.domains.orders.refunds import RefundService
from velo.domains.payments.registry import PaymentProviders

pytestmark = pytest.mark.integration

NewBrowser = Callable[[], AbstractAsyncContextManager[Browser]]
PRICE = 5000
# Two lamps to CA: $100.00 + 7.25% tax; shipping is free from $75 (test_cart.py).
LINE_TOTAL = 10000 + 725
ORDER_TOTAL = LINE_TOTAL
# One lamp: $50.00 + $3.63 tax, and $5.99 standard shipping.
ONE_LINE = 5000 + 363
ONE_TOTAL = ONE_LINE + 599
TRACKING_SECRET = "tracking-webhook-secret"


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
def tracking_secret() -> str:
    """Set for every test in tests/conftest.py (TEST_ENV)."""
    return TRACKING_SECRET


async def place(
    browser: Browser,
    stripe: FakeStripe,
    providers: PaymentProviders,
    lamp: dict[str, Any],
    quantity: int = 2,
) -> dict[str, Any]:
    """A paid order for ``quantity`` lamps. Returns the customer's view of it, with its token."""
    checkout_id = await checkout_ready(browser, lamp, quantity)
    done = await paid(browser, stripe, providers, checkout_id)
    number = done["order_number"]
    order_id = await sql("SELECT id FROM orders WHERE order_number = :n", n=number)
    response = await browser.post(
        "/api/v1/orders/lookup", json={"number": number, "email": "ada@example.com"}
    )
    assert response.status_code == 200, response.text
    view = dict(response.json())
    view["id"] = str(order_id)
    return view


def err(response: Any) -> tuple[int, str]:
    """``(status, slug)`` of a problem response."""
    return response.status_code, problem(response)


def line_id(order: dict[str, Any]) -> str:
    return str(order["lines"][0]["id"])


async def admin_order(admin: Browser, order: dict[str, Any]) -> dict[str, Any]:
    response = await admin.get(f"/api/v1/admin/orders/{order['id']}")
    assert response.status_code == 200, response.text
    return dict(response.json())


def signed(body: dict[str, Any]) -> tuple[bytes, dict[str, str]]:
    raw = json.dumps(body).encode()
    signature = hmac.new(TRACKING_SECRET.encode(), raw, hashlib.sha256).hexdigest()
    return raw, {"X-Velo-Signature": signature, "Content-Type": "application/json"}


# ── The Definition of Done ────────────────────────────────────────────────────


async def test_an_operator_takes_an_order_from_paid_to_delivered(
    browser: Browser,
    admin: Browser,
    stripe: FakeStripe,
    providers: PaymentProviders,
    lamp: dict[str, Any],
    tracking_secret: str,
) -> None:
    order = await place(browser, stripe, providers, lamp)
    assert order["status"] == "paid" and order["fulfilment_status"] == "unfulfilled"
    assert order["totals"]["total"]["amount"] == ORDER_TOTAL

    started = await admin.post(
        f"/api/v1/admin/orders/{order['id']}/status", json={"status": "processing"}
    )
    assert started.status_code == 200, started.text
    assert started.json()["status"] == "processing"

    # Ship one lamp now, the other later.
    first = await admin.post(
        f"/api/v1/admin/orders/{order['id']}/fulfilments",
        json={
            "lines": [{"order_item_id": line_id(order), "quantity": 1}],
            "carrier": "UPS",
            "tracking_number": "1Z999AA10123456784",
        },
    )
    assert first.status_code == 201, first.text
    assert first.json()["tracking_url"] == "https://www.ups.com/track?tracknum=1Z999AA10123456784"
    detail = await admin_order(admin, order)
    assert detail["status"] == "partially_fulfilled"
    assert detail["fulfilment_status"] == "partially_fulfilled"

    # Nothing more than is left can ship.
    too_many = await admin.post(
        f"/api/v1/admin/orders/{order['id']}/fulfilments",
        json={"lines": [{"order_item_id": line_id(order), "quantity": 2}], "carrier": "UPS"},
    )
    assert err(too_many) == (422, "quantity-exceeded")

    second = await admin.post(
        f"/api/v1/admin/orders/{order['id']}/fulfilments",
        json={"carrier": "usps", "tracking_number": "9400100000000000000000"},
    )
    assert second.status_code == 201, second.text
    detail = await admin_order(admin, order)
    assert detail["status"] == "fulfilled" and detail["fulfilment_status"] == "fulfilled"

    # The carrier reports both parcels delivered; the order follows.
    for number in ("1Z999AA10123456784", "9400100000000000000000"):
        raw, headers = signed({"tracking_number": number, "status": "delivered"})
        delivered = await admin.client.post(
            "/api/v1/webhooks/tracking", content=raw, headers=headers
        )
        assert delivered.status_code == 200, delivered.text
    detail = await admin_order(admin, order)
    assert detail["status"] == "delivered"
    assert all(parcel["status"] == "delivered" for parcel in detail["shipments"])

    # Every step is in the audit trail, in order, with its actor.
    trail = [(e["event_type"], e["actor_type"]) for e in detail["events"]]
    assert trail == [
        ("created", "webhook"),
        ("status_changed", "staff"),
        ("partially_fulfilled", "staff"),
        ("fulfilled", "staff"),
        ("shipment_delivered", "webhook"),
        ("shipment_delivered", "webhook"),
        ("delivered", "webhook"),
    ]
    assert await sql("SELECT count(*) FROM audit_log WHERE action LIKE 'order.%'") == 3


async def test_a_partial_return_and_its_partial_refund(
    browser: Browser,
    admin: Browser,
    stripe: FakeStripe,
    providers: PaymentProviders,
    lamp: dict[str, Any],
    worker_ctx: dict[str, Any],
    mailer: InMemoryMailer,
) -> None:
    order = await place(browser, stripe, providers, lamp)
    token = order["access_token"]
    await admin.post(f"/api/v1/admin/orders/{order['id']}/fulfilments", json={"carrier": "ups"})
    assert await stock(lamp["id"]) == (1, 0)  # 3 - 2 sold

    # The customer, as a guest through the signed link, returns one of the two.
    requested = await browser.post(
        f"/api/v1/orders/{order['number']}/returns?token={token}",
        json={
            "items": [{"order_item_id": line_id(order), "quantity": 1}],
            "reason": "wrong_size",
        },
    )
    assert requested.status_code == 201, requested.text
    returned = requested.json()
    assert returned["status"] == "requested" and returned["rma_number"].startswith("RMA-")
    # The second unit is still returnable; the first is claimed.
    view = (await browser.get(f"/api/v1/orders/{order['number']}?token={token}")).json()
    assert view["lines"][0]["returnable_quantity"] == 1

    # No label before approval.
    label_url = f"/api/v1/orders/{order['number']}/returns/{returned['rma_number']}/label"
    assert (await browser.get(f"{label_url}?token={token}")).status_code == 404

    admin_returns = f"/api/v1/admin/returns/{returned['id']}"
    approved = await admin.patch(admin_returns, json={"action": "approve"})
    assert approved.status_code == 200 and approved.json()["status"] == "approved"
    label = await browser.get(f"{label_url}?token={token}")
    assert label.status_code == 200 and label.content.startswith(b"%PDF")

    received = await admin.patch(
        admin_returns,
        json={
            "action": "receive",
            "lines": [{"order_item_id": line_id(order), "condition": "opened", "restock": True}],
        },
    )
    assert received.status_code == 200, received.text
    assert received.json()["lines"][0]["condition"] == "opened"
    assert await stock(lamp["id"]) == (2, 0)  # the returned lamp is back on the shelf

    refunded = await admin.patch(admin_returns, json={"action": "refund"})
    assert refunded.status_code == 200, refunded.text
    assert refunded.json()["status"] == "refunded"
    # One lamp's share of the line: half of 107.25, exactly.
    assert refunded.json()["refund_amount"]["amount"] == LINE_TOTAL // 2
    intent_id = stripe.only_intent()
    assert stripe.refunded(intent_id) == LINE_TOTAL // 2

    detail = await admin_order(admin, order)
    assert detail["payment_status"] == "partially_refunded"
    assert detail["totals"]["refunded"]["amount"] == LINE_TOTAL // 2
    assert detail["lines"][0]["quantity_returned"] == 1
    assert detail["refundable"]["amount"] == ORDER_TOTAL - LINE_TOTAL // 2
    events = [e["event_type"] for e in detail["events"]]
    for expected in (
        "return_requested",
        "return_approved",
        "return_received",
        "refund_requested",
        "refunded",
        "return_refunded",
    ):
        assert expected in events

    await drain(worker_ctx)
    subjects = [m.subject for m in mailer.outbox if m.to == "ada@example.com"]
    assert any("on its way" in s for s in subjects)
    assert any(returned["rma_number"] in s and "approved" in s for s in subjects)
    assert any(s.startswith("Refund for order") for s in subjects)


async def test_a_partial_refund_at_line_level_is_idempotent(
    browser: Browser,
    admin: Browser,
    stripe: FakeStripe,
    providers: PaymentProviders,
    lamp: dict[str, Any],
) -> None:
    order = await place(browser, stripe, providers, lamp)
    headers = key()
    body = {
        "lines": [{"order_item_id": line_id(order), "quantity": 1}],
        "reason": "defective",
        "note": "Scratched base",
    }
    first = await admin.post(
        f"/api/v1/admin/orders/{order['id']}/refunds", json=body, headers=headers
    )
    assert first.status_code == 201, first.text
    assert first.json()["amount"]["amount"] == LINE_TOTAL // 2
    assert first.json()["status"] == "succeeded"
    replay = await admin.post(
        f"/api/v1/admin/orders/{order['id']}/refunds", json=body, headers=headers
    )
    assert replay.status_code == 201
    assert replay.headers["Idempotency-Replayed"] == "true"
    assert replay.json() == first.json()
    assert len(stripe.refunds_by_key) == 1
    assert await sql("SELECT count(*) FROM refunds") == 1

    # Refunding needs the key.
    missing = await admin.post(f"/api/v1/admin/orders/{order['id']}/refunds", json=body)
    assert missing.status_code == 400


async def test_refunds_never_exceed_the_capture(
    browser: Browser,
    admin: Browser,
    stripe: FakeStripe,
    providers: PaymentProviders,
    lamp: dict[str, Any],
) -> None:
    order = await place(browser, stripe, providers, lamp, quantity=1)
    url = f"/api/v1/admin/orders/{order['id']}/refunds"

    too_much = await admin.post(
        url, json={"extra_amount": ONE_TOTAL + 1, "reason": "other"}, headers=key()
    )
    assert err(too_much) == (422, "refund-exceeds-capture")

    # The lamp, then shipping — then there is nothing left.
    lines = await admin.post(
        url,
        json={"lines": [{"order_item_id": line_id(order), "quantity": 1}], "reason": "other"},
        headers=key(),
    )
    assert lines.status_code == 201 and lines.json()["amount"]["amount"] == ONE_LINE
    again = await admin.post(
        url,
        json={"lines": [{"order_item_id": line_id(order), "quantity": 1}], "reason": "other"},
        headers=key(),
    )
    assert err(again) == (422, "quantity-exceeded")
    shipping = await admin.post(
        url, json={"include_shipping": True, "reason": "other"}, headers=key()
    )
    assert shipping.status_code == 201 and shipping.json()["amount"]["amount"] == 599
    # Shipping cannot be given back twice.
    twice = await admin.post(url, json={"include_shipping": True, "reason": "other"}, headers=key())
    assert err(twice) == (422, "nothing-to-refund")
    empty = await admin.post(url, json={"extra_amount": 1, "reason": "other"}, headers=key())
    assert err(empty) == (422, "refund-exceeds-capture")

    detail = await admin_order(admin, order)
    assert detail["payment_status"] == "refunded" and detail["status"] == "refunded"
    assert await sql("SELECT amount_refunded FROM payments") == ONE_TOTAL


async def test_simultaneous_refunds_totalling_more_than_the_capture(
    browser: Browser,
    admin: Browser,
    stripe: FakeStripe,
    providers: PaymentProviders,
    lamp: dict[str, Any],
) -> None:
    """PAYMENTS-AND-CHECKOUT.md §11: only one fits, whatever the timing."""
    order = await place(browser, stripe, providers, lamp)
    amount = ORDER_TOTAL * 2 // 3  # two of these exceed the capture
    stripe.delay = 0.2  # hold each provider call open so the requests overlap

    async def attempt() -> tuple[int, str]:
        response = await admin.post(
            f"/api/v1/admin/orders/{order['id']}/refunds",
            json={"extra_amount": amount, "reason": "other"},
            headers=key(),
        )
        return response.status_code, response.text

    results = await asyncio.gather(*(attempt() for _ in range(4)))
    codes = sorted(code for code, _ in results)
    assert codes == [201, 422, 422, 422], results
    assert await sql("SELECT count(*) FROM refunds") == 1
    assert sum(r["amount"] for r in stripe.refunds_by_key.values()) == amount


async def test_a_customer_cancels_before_shipping_and_is_refunded_in_full(
    browser: Browser,
    admin: Browser,
    stripe: FakeStripe,
    providers: PaymentProviders,
    lamp: dict[str, Any],
    worker_ctx: dict[str, Any],
    mailer: InMemoryMailer,
) -> None:
    order = await place(browser, stripe, providers, lamp)
    assert order["can_cancel"] is True
    assert await stock(lamp["id"]) == (1, 0)

    cancelled = await browser.post(
        f"/api/v1/orders/{order['number']}/cancel?token={order['access_token']}",
        json={"reason": "Ordered by mistake"},
    )
    assert cancelled.status_code == 200, cancelled.text
    view = cancelled.json()
    assert view["status"] == "cancelled" and view["can_cancel"] is False
    assert view["payment_status"] == "refunded"
    assert view["totals"]["refunded"]["amount"] == ORDER_TOTAL
    assert stripe.refunded(stripe.only_intent()) == ORDER_TOTAL
    assert await stock(lamp["id"]) == (3, 0)  # both lamps back
    assert (
        await sql("SELECT sum(quantity_delta) FROM inventory_movements WHERE reason = 'return'")
        == 2
    )

    # Twice is no different from once.
    again = await browser.post(
        f"/api/v1/orders/{order['number']}/cancel?token={order['access_token']}", json={}
    )
    assert err(again) == (409, "not-cancellable")
    assert await stock(lamp["id"]) == (3, 0)

    await drain(worker_ctx)
    subjects = [m.subject for m in mailer.outbox if m.to == "ada@example.com"]
    assert any("is cancelled" in s for s in subjects)


async def test_nothing_can_be_cancelled_once_it_has_shipped(
    browser: Browser,
    admin: Browser,
    stripe: FakeStripe,
    providers: PaymentProviders,
    lamp: dict[str, Any],
) -> None:
    order = await place(browser, stripe, providers, lamp)
    await admin.post(
        f"/api/v1/admin/orders/{order['id']}/fulfilments",
        json={"lines": [{"order_item_id": line_id(order), "quantity": 1}]},
    )
    by_customer = await browser.post(
        f"/api/v1/orders/{order['number']}/cancel?token={order['access_token']}", json={}
    )
    assert err(by_customer) == (409, "not-cancellable")
    by_staff = await admin.post(f"/api/v1/admin/orders/{order['id']}/cancel", json={})
    assert err(by_staff) == (409, "not-cancellable")


async def test_a_refund_with_restock_before_shipping_takes_the_units_off_the_order(
    browser: Browser,
    admin: Browser,
    stripe: FakeStripe,
    providers: PaymentProviders,
    lamp: dict[str, Any],
) -> None:
    order = await place(browser, stripe, providers, lamp)
    refund = await admin.post(
        f"/api/v1/admin/orders/{order['id']}/refunds",
        json={
            "lines": [{"order_item_id": line_id(order), "quantity": 1, "restock": True}],
            "reason": "requested_by_customer",
        },
        headers=key(),
    )
    assert refund.status_code == 201, refund.text
    assert await stock(lamp["id"]) == (2, 0)

    # Only the one lamp still on the order ships, and that fulfils it.
    shipped = await admin.post(f"/api/v1/admin/orders/{order['id']}/fulfilments", json={})
    assert shipped.status_code == 201
    assert shipped.json()["lines"][0]["quantity"] == 1
    detail = await admin_order(admin, order)
    assert detail["status"] == "fulfilled"


async def test_a_refund_the_provider_could_not_take_is_submitted_later(
    browser: Browser,
    admin: Browser,
    stripe: FakeStripe,
    providers: PaymentProviders,
    lamp: dict[str, Any],
) -> None:
    order = await place(browser, stripe, providers, lamp)
    stripe.down = True
    refund = await admin.post(
        f"/api/v1/admin/orders/{order['id']}/refunds",
        json={"extra_amount": 1000, "reason": "other"},
        headers=key(),
    )
    assert refund.status_code == 201, refund.text
    assert refund.json()["status"] == "pending"
    assert refund.json()["attempts"] == 1
    assert "503" in (refund.json()["last_error"] or "") or refund.json()["last_error"]
    # It still counts against the capture while it is on its way.
    detail = await admin_order(admin, order)
    assert detail["refundable"]["amount"] == ORDER_TOTAL - 1000

    stripe.down = False
    async with open_session() as session:
        counts = await RefundService(session, providers).submit_stranded(older_than=timedelta(0))
    assert counts == {"found": 1, "submitted": 1}
    assert stripe.refunded(stripe.only_intent()) == 1000
    detail = await admin_order(admin, order)
    assert detail["admin_refunds"][0]["status"] == "succeeded"
    assert detail["totals"]["refunded"]["amount"] == 1000


async def test_the_refund_webhook_after_our_own_refund_counts_it_once(
    browser: Browser,
    admin: Browser,
    stripe: FakeStripe,
    providers: PaymentProviders,
    lamp: dict[str, Any],
) -> None:
    from tests.integration.checkout_support import deliver, process_events

    order = await place(browser, stripe, providers, lamp)
    response = await admin.post(
        f"/api/v1/admin/orders/{order['id']}/refunds",
        json={"extra_amount": 2500, "reason": "other"},
        headers=key(),
    )
    assert response.status_code == 201
    intent_id = stripe.only_intent()
    refund_id = next(iter(stripe.refunds_by_key.values()))["id"]
    event = stripe.event(
        "charge.refunded",
        intent_id,
        id=f"ch_{intent_id}",
        object="charge",
        amount_refunded=2500,
        refunds={"data": [{"id": refund_id, "amount": 2500, "status": "succeeded"}]},
    )
    assert (await deliver(browser, event)).status_code == 200
    await process_events(providers)

    assert await sql("SELECT count(*) FROM refunds") == 1
    assert await sql("SELECT refunded_amount FROM orders") == 2500
    assert await sql("SELECT amount_refunded FROM payments") == 2500


# ── Access, search, documents ─────────────────────────────────────────────────


async def test_a_guest_reaches_their_order_only_with_its_link_or_its_email(
    browser: Browser,
    new_browser: NewBrowser,
    stripe: FakeStripe,
    providers: PaymentProviders,
    lamp: dict[str, Any],
) -> None:
    order = await place(browser, stripe, providers, lamp)
    async with new_browser() as stranger:
        url = f"/api/v1/orders/{order['number']}"
        assert (await stranger.get(url)).status_code == 404
        assert (await stranger.get(f"{url}?token={'0' * 32}")).status_code == 404
        mine = await stranger.get(f"{url}?token={order['access_token']}")
        assert mine.status_code == 200 and mine.json()["number"] == order["number"]
        wrong = await stranger.post(
            "/api/v1/orders/lookup", json={"number": order["number"], "email": "eve@example.com"}
        )
        assert wrong.status_code == 404


async def test_a_signed_in_customer_lists_their_orders(
    new_browser: NewBrowser, stripe: FakeStripe, providers: PaymentProviders, lamp: dict[str, Any]
) -> None:
    async with new_browser() as grace:
        await sign_in_as(grace, "grace@example.com")
        checkout_id = await checkout_ready(grace, lamp, 1)
        done = await paid(grace, stripe, providers, checkout_id)
        listed = await grace.get("/api/v1/orders")
        assert listed.status_code == 200
        assert [o["number"] for o in listed.json()["data"]] == [done["order_number"]]
        assert listed.json()["data"][0]["item_count"] == 1
        detail = await grace.get(f"/api/v1/orders/{done['order_number']}")
        assert detail.status_code == 200
        assert detail.json()["payment"]["card_last4"] == "4242"
    async with new_browser() as anonymous:
        assert (await anonymous.get("/api/v1/orders")).status_code == 401


async def test_admin_order_search_by_number_email_and_sku(
    browser: Browser,
    admin: Browser,
    stripe: FakeStripe,
    providers: PaymentProviders,
    lamp: dict[str, Any],
) -> None:
    order = await place(browser, stripe, providers, lamp, quantity=1)
    for q in (order["number"], order["number"].lower(), "ADA@example.com", "LAMP-1", "lamp-1"):
        found = await admin.get("/api/v1/admin/orders", params={"q": q})
        assert found.status_code == 200, found.text
        assert [o["number"] for o in found.json()["data"]] == [order["number"]], q
        assert found.json()["pagination"]["total_count"] == 1
    none = await admin.get("/api/v1/admin/orders", params={"q": "nobody@example.com"})
    assert none.json()["data"] == []
    paid_only = await admin.get("/api/v1/admin/orders", params={"status": "cancelled"})
    assert paid_only.json()["data"] == []
    # By value, inclusive at both ends (one lamp: 5962).
    in_range = await admin.get(
        "/api/v1/admin/orders", params={"min_total": 5962, "max_total": 5962}
    )
    assert len(in_range.json()["data"]) == 1
    above = await admin.get("/api/v1/admin/orders", params={"min_total": 5963})
    assert above.json()["data"] == []


async def test_invoice_and_packing_slip_are_pdfs(
    browser: Browser,
    admin: Browser,
    stripe: FakeStripe,
    providers: PaymentProviders,
    lamp: dict[str, Any],
) -> None:
    order = await place(browser, stripe, providers, lamp)
    invoice = await browser.get(
        f"/api/v1/orders/{order['number']}/invoice?token={order['access_token']}"
    )
    assert invoice.status_code == 200
    assert invoice.headers["content-type"] == "application/pdf"
    assert invoice.content.startswith(b"%PDF")
    slip = await admin.get(f"/api/v1/admin/orders/{order['id']}/packing-slip")
    assert slip.status_code == 200 and slip.content.startswith(b"%PDF")
    admin_invoice = await admin.get(f"/api/v1/admin/orders/{order['id']}/invoice")
    assert admin_invoice.status_code == 200


# ── Guards ────────────────────────────────────────────────────────────────────


async def test_fulfilment_staff_cannot_refund(
    new_browser: NewBrowser,
    browser: Browser,
    stripe: FakeStripe,
    providers: PaymentProviders,
    lamp: dict[str, Any],
) -> None:
    order = await place(browser, stripe, providers, lamp)
    async with new_browser() as picker:
        await sign_in_as(picker, "picker@example.com", "fulfilment")
        shipped = await picker.post(
            f"/api/v1/admin/orders/{order['id']}/fulfilments", json={"carrier": "dhl"}
        )
        assert shipped.status_code == 201
        refund = await picker.post(
            f"/api/v1/admin/orders/{order['id']}/refunds",
            json={"extra_amount": 100, "reason": "other"},
            headers=key(),
        )
        assert refund.status_code == 403
        cancel = await picker.post(f"/api/v1/admin/orders/{order['id']}/cancel", json={})
        assert cancel.status_code == 403
    async with new_browser() as customer:
        await sign_in_as(customer, "someone@example.com")
        assert (await customer.get(f"/api/v1/admin/orders/{order['id']}")).status_code == 403


async def test_a_disputed_order_is_held(
    browser: Browser,
    admin: Browser,
    stripe: FakeStripe,
    providers: PaymentProviders,
    lamp: dict[str, Any],
) -> None:
    order = await place(browser, stripe, providers, lamp)
    await sql(
        "UPDATE orders SET metadata = "
        "jsonb_build_object('dispute', jsonb_build_object('open', true))"
    )
    held = await admin.post(f"/api/v1/admin/orders/{order['id']}/fulfilments", json={})
    assert err(held) == (409, "fulfilment-blocked")
    listed = await admin.get("/api/v1/admin/orders")
    assert listed.json()["data"][0]["needs_attention"] is True


async def test_a_tracking_update_with_a_bad_signature_is_refused(
    admin: Browser, tracking_secret: str
) -> None:
    raw, headers = signed({"tracking_number": "X", "status": "delivered"})
    headers["X-Velo-Signature"] = "0" * 64
    response = await admin.client.post("/api/v1/webhooks/tracking", content=raw, headers=headers)
    assert response.status_code == 400


async def test_a_return_outside_the_window_is_refused(
    browser: Browser,
    admin: Browser,
    stripe: FakeStripe,
    providers: PaymentProviders,
    lamp: dict[str, Any],
) -> None:
    order = await place(browser, stripe, providers, lamp)
    await admin.post(f"/api/v1/admin/orders/{order['id']}/fulfilments", json={})
    await sql("UPDATE fulfilments SET shipped_at = now() - interval '60 days'")
    response = await browser.post(
        f"/api/v1/orders/{order['number']}/returns?token={order['access_token']}",
        json={"items": [{"order_item_id": line_id(order), "quantity": 1}], "reason": "other"},
    )
    assert err(response) == (409, "return-not-allowed")


async def test_the_confirmation_email_carries_the_invoice(
    browser: Browser,
    stripe: FakeStripe,
    providers: PaymentProviders,
    lamp: dict[str, Any],
    worker_ctx: dict[str, Any],
    mailer: InMemoryMailer,
) -> None:
    order = await place(browser, stripe, providers, lamp, quantity=1)
    await drain(worker_ctx)
    confirmation = next(m for m in mailer.outbox if m.subject.endswith("confirmed"))
    assert f"/orders/{order['number']}?token={order['access_token']}" in confirmation.text
    (invoice,) = confirmation.attachments
    assert invoice.filename == f"invoice-{order['number']}.pdf"
    assert invoice.content.startswith(b"%PDF")


async def test_admin_lists_carry_what_the_screens_need(
    browser: Browser,
    admin: Browser,
    stripe: FakeStripe,
    providers: PaymentProviders,
    lamp: dict[str, Any],
) -> None:
    first = await place(browser, stripe, providers, lamp, quantity=1)
    second = await place(browser, stripe, providers, lamp, quantity=1)
    oldest = await admin.get("/api/v1/admin/orders", params={"sort": "oldest"})
    assert [o["number"] for o in oldest.json()["data"]] == [first["number"], second["number"]]

    await sql(
        "UPDATE orders SET metadata = jsonb_build_object('attention', 'shortfall') "
        "WHERE order_number = :n",
        n=second["number"],
    )
    flagged = await admin.get("/api/v1/admin/orders", params={"needs_attention": "true"})
    assert [o["number"] for o in flagged.json()["data"]] == [second["number"]]

    await admin.post(f"/api/v1/admin/orders/{first['id']}/fulfilments", json={})
    await browser.post(
        f"/api/v1/orders/{first['number']}/returns?token={first['access_token']}",
        json={"items": [{"order_item_id": line_id(first), "quantity": 1}], "reason": "other"},
    )
    queue = (await admin.get("/api/v1/admin/returns")).json()
    assert queue["pagination"]["total_count"] == 1
    (returned,) = queue["data"]
    assert returned["order_id"] == first["id"]
    assert returned["lines"][0]["product_title"] == "Desk Lamp"

    detail = await admin_order(admin, first)
    assert detail["payment_reference"]["intent_id"].startswith("pi_")
    staff_events = [e for e in detail["events"] if e["actor_type"] == "staff"]
    assert staff_events and staff_events[0]["actor_email"] == "admin@example.com"
    assert (await admin.get("/api/v1/admin/me")).json()["store_currency"] == "USD"
