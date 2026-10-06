"""Email templates, signed links, webhook signatures, retry backoff (PLANNING.md Phase 12)."""

from __future__ import annotations

import base64
import re
import time
import uuid

import pytest
from jinja2 import UndefinedError
from pydantic import SecretStr

from velo.api.v1.email import sign_svix, verify_svix
from velo.core.config import Settings
from velo.core.email import EmailMessage, InMemoryMailer
from velo.domains.payments.exceptions import WebhookSignatureError
from velo.domains.platform.job_failures import backoff_seconds
from velo.domains.system.worker_health import WorkerHealth
from velo.emails.render import KINDS, render
from velo.emails.tokens import (
    cart_token,
    read_cart_token,
    read_unsubscribe_token,
    unsubscribe_token,
)
from velo.emails.transport import (
    ResendTransport,
    SmtpTransport,
    TransportError,
    TransportMailer,
    build_transport,
)

STORE = {"name": "Velo", "support_email": "help@velo.dev", "address": ["1 Way", "SF"]}
TEXTS = {
    "order_confirmed_intro": "Thanks!",
    "order_shipped_intro": "It shipped.",
    "signature": "The Velo team",
}


@pytest.mark.parametrize("kind", sorted(KINDS))
def test_every_email_renders_in_both_forms(kind: str) -> None:
    spec = KINDS[kind]
    unsubscribe = "https://x/unsubscribe?token=t" if spec.category == "marketing" else None
    rendered = render(kind, spec.sample, store=STORE, texts=TEXTS, unsubscribe_url=unsubscribe)
    assert rendered.subject and "{" not in rendered.subject
    assert rendered.html.startswith("<!doctype html>")
    assert "Velo" in rendered.html
    assert 'width="600"' in rendered.html  # the email-client layout, not a web page
    assert "<" not in re.sub(r"<https?://[^>]+>", "", rendered.text)  # plain text has no markup
    assert len(rendered.text) > 40
    if unsubscribe:
        assert unsubscribe in rendered.html and unsubscribe in rendered.text


def test_html_is_escaped_and_text_is_not() -> None:
    sample = {**KINDS["back_in_stock"].sample, "product_title": "<script>x</script> & Co"}
    rendered = render("back_in_stock", sample, store=STORE, texts=TEXTS)
    assert "<script>" not in rendered.html and "&lt;script&gt;" in rendered.html
    assert "<script>x</script> & Co" in rendered.text


def test_a_missing_value_is_an_error_not_a_blank() -> None:
    with pytest.raises(UndefinedError):
        render("order_confirmed", {"order_number": "VLO-1"}, store=STORE, texts=TEXTS)


def test_unsubscribe_tokens_round_trip_and_resist_tampering() -> None:
    token = unsubscribe_token("s" * 32, "Ada@Example.com", "cart_recovery")
    assert read_unsubscribe_token("s" * 32, token) == ("ada@example.com", "cart_recovery")
    assert read_unsubscribe_token("t" * 32, token) is None
    forged = base64.urlsafe_b64encode(b"eve@example.com|cart_recovery|0000").decode()
    assert read_unsubscribe_token("s" * 32, forged) is None
    assert read_unsubscribe_token("s" * 32, "not-a-token!") is None


def test_cart_tokens() -> None:
    cart_id = uuid.uuid4()
    assert read_cart_token("s" * 32, cart_token("s" * 32, cart_id)) == cart_id
    assert read_cart_token("t" * 32, cart_token("s" * 32, cart_id)) is None


SECRET = "whsec_" + base64.b64encode(b"svix-test-secret").decode()


def _headers(body: bytes, *, at: int | None = None, secret: str = SECRET) -> dict[str, str]:
    stamp = at or int(time.time())
    return {
        "svix-id": "msg_1",
        "svix-timestamp": str(stamp),
        "svix-signature": sign_svix(secret, "msg_1", stamp, body),
    }


def test_svix_signatures() -> None:
    body = b'{"type":"email.delivered"}'
    verify_svix(SECRET, _headers(body), body)
    with pytest.raises(WebhookSignatureError):
        verify_svix(SECRET, _headers(body), body + b" ")
    with pytest.raises(WebhookSignatureError):
        verify_svix(SECRET, _headers(body, at=int(time.time()) - 3600), body)
    other = "whsec_" + base64.b64encode(b"another").decode()
    with pytest.raises(WebhookSignatureError):
        verify_svix(SECRET, _headers(body, secret=other), body)
    with pytest.raises(WebhookSignatureError):
        verify_svix(SECRET, {}, body)


def test_backoff_doubles_and_caps() -> None:
    assert [backoff_seconds(n) for n in range(1, 6)] == [5, 10, 20, 40, 80]
    assert backoff_seconds(20) == 600


def test_worker_health_in_prometheus_format() -> None:
    health = WorkerHealth(
        healthy=True,
        heartbeat_at=None,
        heartbeat_age_seconds=3.0,
        queue_depth=2,
        outbox_pending=1,
        outbox_stuck=0,
        dead_jobs=0,
        dead_payment_events=0,
        emails_failed_24h=0,
    )
    text = health.prometheus()
    assert "# TYPE velo_worker_up gauge\nvelo_worker_up 1\n" in text
    assert "velo_queue_depth 2\n" in text


async def test_the_request_path_mailer_sends_through_the_transport_and_swallows_failures() -> None:
    transport = InMemoryMailer()
    mailer = TransportMailer(transport)
    message = EmailMessage(to="ada@example.com", subject="Reset your password", text="…")

    assert await mailer.send(message) == "mem-1"
    transport.fail_next = TransportError("Resend 503")
    assert await mailer.send(message) is None  # logged, never raised into the request
    assert transport.outbox == [message]


def test_the_configured_transport_is_resend_when_keyed_and_smtp_otherwise() -> None:
    # A developer's .env may contain the real Resend key; test SMTP explicitly.
    assert isinstance(build_transport(Settings(resend_api_key=SecretStr(""))), SmtpTransport)
    keyed = build_transport(Settings(resend_api_key=SecretStr("re_test")))
    assert isinstance(keyed, ResendTransport)
