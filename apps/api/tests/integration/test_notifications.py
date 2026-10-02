"""Notifications and background jobs end to end (PLANNING.md Phase 12).

The Definition of Done: every customer-facing event sends the right email
exactly once; jobs retry and alert when they run out; no event is lost while
the worker is down (the outbox holds it until the relay runs).
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from typing import Any

import pytest
from fastapi import FastAPI

from tests.integration.catalog_support import sql
from tests.integration.checkout_support import FakeStripe, providers_for
from tests.integration.conftest import Browser, drain, sign_in_as
from tests.integration.test_cart import add
from tests.integration.test_checkout import checkout_ready, paid
from tests.integration.test_checkout import lamp as lamp
from velo.api.v1.email import sign_svix
from velo.core.config import get_settings
from velo.core.email import EmailMessage, InMemoryMailer
from velo.db.session import open_session
from velo.domains.payments.registry import PaymentProviders
from velo.domains.platform.job_failures import MAX_TRIES, retrying
from velo.emails.cart_recovery import CartRecovery
from velo.emails.tokens import cart_token, unsubscribe_token
from velo.emails.transport import TransportError

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


def confirmations(mailer: InMemoryMailer, to: str = "ada@example.com") -> list[Any]:
    return [m for m in mailer.outbox if m.to == to and m.subject.endswith("confirmed")]


# ── Exactly once ──────────────────────────────────────────────────────────────


async def test_an_event_relayed_twice_emails_once(
    browser: Browser,
    stripe: FakeStripe,
    providers: PaymentProviders,
    lamp: dict[str, Any],
    worker_ctx: dict[str, Any],
    mailer: InMemoryMailer,
) -> None:
    checkout_id = await checkout_ready(browser, lamp, 1)
    await paid(browser, stripe, providers, checkout_id)
    await drain(worker_ctx)
    assert len(confirmations(mailer)) == 1
    sent = confirmations(mailer)[0]
    assert sent.html and "<!doctype html>" in sent.html  # HTML with a plain-text twin
    assert "1 x Desk Lamp" in sent.text

    # The relay crashed after sending but before marking the event published.
    await sql("UPDATE outbox_events SET published_at = NULL WHERE event_type = 'order.created'")
    await drain(worker_ctx)
    assert len(confirmations(mailer)) == 1
    assert await sql("SELECT status FROM sent_emails WHERE kind = 'order_confirmed'") == "sent"


async def test_a_failed_send_is_retried_and_still_sent_once(
    browser: Browser,
    stripe: FakeStripe,
    providers: PaymentProviders,
    lamp: dict[str, Any],
    worker_ctx: dict[str, Any],
    mailer: InMemoryMailer,
) -> None:
    checkout_id = await checkout_ready(browser, lamp, 1)
    await paid(browser, stripe, providers, checkout_id)
    # Everything else first, so the failure lands on the confirmation.
    await sql("UPDATE outbox_events SET published_at = now() WHERE event_type <> 'order.created'")
    mailer.fail_next = TransportError("provider down")
    await drain(worker_ctx)
    assert confirmations(mailer) == []
    assert await sql("SELECT status FROM sent_emails WHERE kind = 'order_confirmed'") == "failed"
    assert await sql("SELECT attempts FROM outbox_events WHERE event_type = 'order.created'") == 1

    await drain(worker_ctx)  # the relay's next round
    assert len(confirmations(mailer)) == 1
    assert await sql("SELECT status FROM sent_emails WHERE kind = 'order_confirmed'") == "sent"


async def test_a_new_account_gets_one_welcome_email(
    new_browser: NewBrowser, worker_ctx: dict[str, Any], mailer: InMemoryMailer
) -> None:
    async with new_browser() as ada:
        await sign_in_as(ada, "welcome@example.com")
    await drain(worker_ctx)
    await drain(worker_ctx)
    welcomes = [m for m in mailer.outbox if m.subject.startswith("Welcome to")]
    assert [m.to for m in welcomes] == ["welcome@example.com"]
    verify = [m for m in mailer.outbox if m.subject == "Confirm your email address"]
    assert verify and verify[0].html and "/verify-email?token=" in verify[0].text


# ── Abandoned carts ───────────────────────────────────────────────────────────


async def _recovery(worker_ctx: dict[str, Any]) -> dict[str, int]:
    worker = worker_ctx["worker"]
    async with open_session() as session:
        return await CartRecovery(session, worker.settings, worker.emails()).run()


async def test_abandoned_cart_reminders_at_1_24_and_72_hours(
    browser: Browser,
    lamp: dict[str, Any],
    worker_ctx: dict[str, Any],
    mailer: InMemoryMailer,
    new_browser: NewBrowser,
) -> None:
    # A guest gives an email at checkout, then leaves.
    await checkout_ready(browser, lamp, 1)
    await sql("UPDATE checkout_sessions SET email = 'leaver@example.com'")

    def reminders() -> list[EmailMessage]:
        return [m for m in mailer.outbox if m.to == "leaver@example.com"]

    assert await _recovery(worker_ctx) == {"sent": 0, "skipped": 0, "failed": 0}  # not idle yet
    await sql("UPDATE carts SET updated_at = now() - interval '2 hours'")
    assert (await _recovery(worker_ctx))["sent"] == 1
    assert (await _recovery(worker_ctx))["sent"] == 0  # once per step
    first = reminders()[0]
    assert "Desk Lamp" in first.text and "/cart/recover?token=" in first.text
    assert first.headers["List-Unsubscribe-Post"] == "List-Unsubscribe=One-Click"

    await sql("UPDATE carts SET updated_at = now() - interval '25 hours'")
    # Moving updated_at back is "no new activity" only if it is not newer than the sequence's.
    await sql("UPDATE cart_reminders SET activity_at = (SELECT updated_at FROM carts)")
    assert (await _recovery(worker_ctx))["sent"] == 1

    # One click from the mail client: no CSRF header, just the signed token.
    token = unsubscribe_token(
        get_settings().secret_key.get_secret_value(), "leaver@example.com", "cart_recovery"
    )
    async with new_browser() as mail_client:
        response = await mail_client.client.post(f"/api/v1/email/unsubscribe?token={token}")
        assert response.status_code == 200, response.text
    await sql("UPDATE carts SET updated_at = now() - interval '73 hours'")
    await sql("UPDATE cart_reminders SET activity_at = (SELECT updated_at FROM carts)")
    assert (await _recovery(worker_ctx)) == {"sent": 0, "skipped": 1, "failed": 0}
    assert len(reminders()) == 2


async def test_a_reminder_link_restores_the_guest_cart_in_another_browser(
    browser: Browser, lamp: dict[str, Any], new_browser: NewBrowser
) -> None:
    await add(browser, lamp["id"], 1)
    cart_id = await sql("SELECT id FROM carts")
    token = cart_token(get_settings().secret_key.get_secret_value(), cart_id)
    async with new_browser() as phone:
        assert (await phone.get("/api/v1/cart")).json()["items"] == []
        restored = await phone.post("/api/v1/cart/recover", json={"token": token})
        assert restored.status_code == 204, restored.text
        assert len((await phone.get("/api/v1/cart")).json()["items"]) == 1
        bad = await phone.post("/api/v1/cart/recover", json={"token": token[:-2] + "xx"})
        assert bad.status_code == 422


async def test_preferences_for_a_signed_in_customer(new_browser: NewBrowser) -> None:
    async with new_browser() as ada:
        await sign_in_as(ada, "prefs@example.com")
        current = (await ada.get("/api/v1/account/preferences")).json()
        assert current == {"order_updates": True, "cart_reminders": True, "marketing": False}
        changed = await ada.patch(
            "/api/v1/account/preferences", json={"cart_reminders": False, "marketing": True}
        )
        assert changed.json() == {"order_updates": True, "cart_reminders": False, "marketing": True}


# ── Delivery status from Resend ───────────────────────────────────────────────


async def test_delivery_and_bounce_events_update_the_log(
    browser: Browser,
    stripe: FakeStripe,
    providers: PaymentProviders,
    lamp: dict[str, Any],
    worker_ctx: dict[str, Any],
) -> None:
    checkout_id = await checkout_ready(browser, lamp, 1)
    await paid(browser, stripe, providers, checkout_id)
    await drain(worker_ctx)
    message_id = await sql(
        "SELECT provider_message_id FROM sent_emails WHERE kind = 'order_confirmed'"
    )
    secret = get_settings().resend_webhook_secret.get_secret_value()

    async def deliver(event_type: str, *, sign: bool = True) -> Any:
        body = json.dumps({"type": event_type, "data": {"email_id": message_id}}).encode()
        stamp = int(time.time())
        headers = {
            "svix-id": f"msg_{event_type}",
            "svix-timestamp": str(stamp),
            "svix-signature": sign_svix(secret, f"msg_{event_type}", stamp, body)
            if sign
            else "v1,forged",
            "Content-Type": "application/json",
        }
        return await browser.client.post("/api/v1/webhooks/resend", content=body, headers=headers)

    assert (await deliver("email.delivered", sign=False)).status_code == 400
    assert (await deliver("email.delivered")).status_code == 200
    assert await sql("SELECT status FROM sent_emails WHERE kind = 'order_confirmed'") == "delivered"
    assert (await deliver("email.complained")).status_code == 200
    assert await sql("SELECT cart_reminders FROM email_preferences") is False


# ── Jobs, health, previews ────────────────────────────────────────────────────


async def test_a_job_that_keeps_failing_is_dead_lettered_and_alerted(
    worker_ctx: dict[str, Any], mailer: InMemoryMailer
) -> None:
    @retrying
    async def flaky(ctx: dict[str, Any], thing: str) -> None:
        raise RuntimeError(f"cannot process {thing}")

    from arq import Retry

    with pytest.raises(Retry):
        await flaky({"job_try": 1}, "x")
    assert await flaky({"job_try": MAX_TRIES}, "x") is None
    assert await sql("SELECT job || ':' || status FROM job_failures") == "flaky:dead"
    await drain(worker_ctx)
    assert any(m.subject == "Payments alert: job.dead_lettered" for m in mailer.outbox)


async def test_worker_health_reports_the_heartbeat(
    admin: Browser, worker_ctx: dict[str, Any]
) -> None:
    from velo.db.redis import get_redis
    from velo.domains.system.worker_health import HEARTBEAT_KEY
    from velo.worker import heartbeat

    await get_redis().delete(HEARTBEAT_KEY)
    assert (await admin.get("/api/v1/system/worker")).json()["healthy"] is False
    await heartbeat(worker_ctx)
    health = (await admin.get("/api/v1/system/worker")).json()
    assert health["healthy"] is True and health["heartbeat_age_seconds"] < 5
    metrics = await admin.get("/api/v1/system/worker", params={"format": "prometheus"})
    assert "velo_worker_up 1" in metrics.text


async def test_email_previews_in_development(browser: Browser) -> None:
    listing = await browser.get("/api/v1/dev/emails")
    assert listing.status_code == 200 and "order_confirmed" in listing.text
    html = await browser.get("/api/v1/dev/emails/order_shipped")
    assert html.status_code == 200 and "1Z999AA10123456784" in html.text
    text = await browser.get("/api/v1/dev/emails/cart_recovery", params={"format": "text"})
    assert text.text.startswith("Subject: You left something in your cart")
