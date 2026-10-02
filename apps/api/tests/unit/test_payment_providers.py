"""The provider adapters, against fake HTTP: signatures, requests, and normalisation."""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import parse_qsl

import httpx
import pytest

from velo.domains.payments import paystack, stripe
from velo.domains.payments.exceptions import PaymentsUnavailableError
from velo.domains.payments.paystack import PaystackProvider
from velo.domains.payments.provider import (
    EventKind,
    IntentStatus,
    ProviderError,
    RefundReason,
    SignatureError,
)
from velo.domains.payments.registry import PaymentProviders
from velo.domains.payments.service import request_fingerprint
from velo.domains.payments.stripe import StripeProvider

SECRET = "whsec_unit"
NOW = 1_800_000_000


def stripe_with(handler: Any, clock: float = NOW) -> StripeProvider:
    return StripeProvider(
        secret_key="sk_test_unit",
        publishable_key="pk_test_unit",
        webhook_secret=SECRET,
        transport=httpx.MockTransport(handler),
        clock=lambda: clock,
    )


def intent_body(**overrides: Any) -> dict[str, Any]:
    return {
        "id": "pi_1",
        "status": "requires_payment_method",
        "amount": 1999,
        "amount_received": 0,
        "currency": "usd",
        "client_secret": "pi_1_secret_x",
        "metadata": {"payment_id": "p-1"},
        **overrides,
    }


def event_bytes(event_type: str = "payment_intent.succeeded", **obj: Any) -> bytes:
    return json.dumps(
        {"id": "evt_1", "type": event_type, "data": {"object": {**intent_body(), **obj}}}
    ).encode()


# ── Stripe: webhook signatures ────────────────────────────────────────────────


def test_a_correctly_signed_stripe_event_is_accepted_and_normalised() -> None:
    body = event_bytes(status="succeeded", amount_received=1999)
    event = stripe_with(None).verify_webhook(body, stripe.sign(body, SECRET, NOW))

    assert event.id == "evt_1"
    assert event.kind is EventKind.PAYMENT_SUCCEEDED
    assert event.intent_id == "pi_1"
    assert event.payment_ref == "p-1"
    assert event.intent is not None
    assert event.intent.status is IntentStatus.SUCCEEDED
    assert event.intent.currency == "USD"


@pytest.mark.parametrize(
    "tamper",
    [
        lambda body, header: (body + b" ", header),  # one byte of body
        lambda body, header: (body, header.replace("v1=", "v1=0")),  # the signature
        lambda body, header: (body, header.replace(f"t={NOW}", f"t={NOW + 1}")),  # the time
        lambda body, header: (body, ""),
        lambda body, header: (body, f"t={NOW}"),  # no v1
        lambda body, header: (body, "v1=abc"),  # no t
    ],
)
def test_anything_but_the_exact_signed_bytes_is_refused(tamper: Any) -> None:
    body = event_bytes()
    body, header = tamper(body, stripe.sign(body, SECRET, NOW))

    with pytest.raises(SignatureError):
        stripe_with(None).verify_webhook(body, header)


def test_a_signature_by_another_secret_is_refused() -> None:
    body = event_bytes()
    with pytest.raises(SignatureError):
        stripe_with(None).verify_webhook(body, stripe.sign(body, "whsec_other", NOW))


def test_an_old_delivery_is_refused_even_when_correctly_signed() -> None:
    body = event_bytes()
    header = stripe.sign(body, SECRET, NOW - 301)  # a captured request, replayed later

    with pytest.raises(SignatureError, match="tolerance"):
        stripe_with(None).verify_webhook(body, header)


def test_any_one_of_several_signatures_may_match_during_secret_rotation() -> None:
    body = event_bytes()
    good = stripe.sign(body, SECRET, NOW).split("v1=")[1]
    header = f"t={NOW},v1={'0' * 64},v1={good}"

    assert stripe_with(None).verify_webhook(body, header).id == "evt_1"


def test_no_webhook_secret_means_no_event_is_trusted() -> None:
    provider = StripeProvider(secret_key="sk", publishable_key="pk", webhook_secret="")
    body = event_bytes()
    with pytest.raises(SignatureError):
        provider.verify_webhook(body, stripe.sign(body, "", NOW))


def test_refund_and_dispute_events_name_their_intent() -> None:
    provider = stripe_with(None)
    refund = provider.parse_event(
        {
            "id": "evt_r",
            "type": "charge.refunded",
            "data": {"object": {"id": "ch_1", "payment_intent": "pi_1", "amount_refunded": 500}},
        }
    )
    dispute = provider.parse_event(
        {
            "id": "evt_d",
            "type": "charge.dispute.created",
            "data": {"object": {"id": "dp_1", "payment_intent": "pi_1", "amount": 1999}},
        }
    )
    other = provider.parse_event(
        {"id": "evt_o", "type": "customer.created", "data": {"object": {}}}
    )

    assert (refund.kind, refund.intent_id, refund.amount_refunded) == (
        EventKind.CHARGE_REFUNDED,
        "pi_1",
        500,
    )
    assert dispute.kind is EventKind.DISPUTE_CREATED and dispute.dispute is not None
    assert dispute.dispute.amount == 1999
    assert other.kind is EventKind.OTHER


# ── Stripe: API calls ─────────────────────────────────────────────────────────


async def test_create_intent_sends_the_amount_currency_and_idempotency_key() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=intent_body())

    intent = await stripe_with(handler).create_intent(
        amount=1999,
        currency="USD",
        idempotency_key="velo-payment-1",
        metadata={"payment_id": "p-1"},
        email="a@example.com",
    )

    form = dict(parse_qsl(seen[0].content.decode()))
    assert seen[0].url.path == "/v1/payment_intents"
    assert seen[0].headers["Idempotency-Key"] == "velo-payment-1"
    assert seen[0].headers["Authorization"] == "Bearer sk_test_unit"
    assert seen[0].headers["Stripe-Version"] == stripe.API_VERSION
    assert form == {
        "amount": "1999",
        "currency": "usd",
        "automatic_payment_methods[enabled]": "true",
        "metadata[payment_id]": "p-1",
    }
    assert "email" not in seen[0].content.decode()
    assert intent.client_secret == "pi_1_secret_x"
    assert intent.status is IntentStatus.REQUIRES_PAYMENT


async def test_get_intent_reads_card_details_from_the_expanded_charge() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["expand[]"] == "latest_charge"
        return httpx.Response(
            200,
            json=intent_body(
                status="succeeded",
                amount_received=1999,
                latest_charge={
                    "id": "ch_1",
                    "amount_refunded": 0,
                    "payment_method_details": {
                        "type": "card",
                        "card": {"brand": "visa", "last4": "4242", "wallet": {"type": "apple_pay"}},
                    },
                },
            ),
        )

    intent = await stripe_with(handler).get_intent("pi_1")

    assert intent.status is IntentStatus.SUCCEEDED
    assert (intent.charge_id, intent.card_brand, intent.card_last4) == ("ch_1", "visa", "4242")
    assert intent.payment_method_type == "apple_pay"


async def test_a_decline_is_reported_with_its_reason() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json=intent_body(
                last_payment_error={
                    "code": "card_declined",
                    "decline_code": "insufficient_funds",
                    "message": "Your card has insufficient funds.",
                }
            ),
        )

    intent = await stripe_with(handler).get_intent("pi_1")

    assert intent.failure_code == "insufficient_funds"
    assert intent.failure_message == "Your card has insufficient funds."


@pytest.mark.parametrize(
    ("status", "retryable"), [(500, True), (503, True), (429, True), (400, False), (402, False)]
)
async def test_provider_errors_say_whether_retrying_can_help(status: int, retryable: bool) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json={"error": {"code": "x", "message": "nope"}})

    with pytest.raises(ProviderError) as caught:
        await stripe_with(handler).get_intent("pi_1")
    assert caught.value.retryable is retryable


async def test_an_unreachable_provider_is_a_retryable_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("timed out")

    with pytest.raises(ProviderError) as caught:
        await stripe_with(handler).get_intent("pi_1")
    assert caught.value.retryable


async def test_refund_maps_our_reasons_to_stripes() -> None:
    seen: list[dict[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(dict(parse_qsl(request.content.decode())))
        return httpx.Response(200, json={"id": "re_1", "status": "succeeded", "amount": 500})

    result = await stripe_with(handler).refund(
        intent_id="pi_1", amount=500, reason=RefundReason.DEFECTIVE, idempotency_key="k"
    )

    assert "reason" not in seen[0]  # Stripe has no 'defective'
    assert seen[0]["metadata[reason]"] == "defective"
    assert (result.id, result.status, result.amount) == ("re_1", "succeeded", 500)


# ── Paystack ──────────────────────────────────────────────────────────────────


def paystack_with(handler: Any) -> PaystackProvider:
    return PaystackProvider(
        secret_key="sk_paystack", public_key="pk_paystack", transport=httpx.MockTransport(handler)
    )


def test_paystack_webhooks_are_verified_with_hmac_sha512() -> None:
    body = json.dumps(
        {
            "event": "charge.success",
            "data": {
                "id": 42,
                "reference": "velo-payment-1",
                "status": "success",
                "amount": 250000,
                "currency": "NGN",
                "channel": "card",
                "authorization": {"brand": "visa", "last4": "4081"},
                "metadata": {"payment_id": "p-1"},
            },
        }
    ).encode()
    provider = paystack_with(None)

    event = provider.verify_webhook(body, paystack.sign(body, "sk_paystack"))
    with pytest.raises(SignatureError):
        provider.verify_webhook(body + b" ", paystack.sign(body, "sk_paystack"))
    with pytest.raises(SignatureError):
        provider.verify_webhook(body, paystack.sign(body, "sk_other"))

    assert event.id == "charge.success:42"
    assert event.kind is EventKind.PAYMENT_SUCCEEDED
    assert event.intent_id == "velo-payment-1"
    assert event.intent is not None
    assert (event.intent.amount_received, event.intent.card_last4) == (250000, "4081")


async def test_paystack_initialises_a_transaction_with_our_reference() -> None:
    seen: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "status": True,
                "data": {
                    "reference": "velo-payment-1",
                    "access_code": "acc_1",
                    "authorization_url": "u",
                },
            },
        )

    intent = await paystack_with(handler).create_intent(
        amount=250000, currency="ngn", idempotency_key="velo-payment-1", metadata={}, email="a@b.ng"
    )

    assert seen[0] == {
        "email": "a@b.ng",
        "amount": 250000,
        "currency": "NGN",
        "reference": "velo-payment-1",
        "metadata": {},
    }
    assert (intent.id, intent.client_secret) == ("velo-payment-1", "acc_1")


async def test_a_duplicate_paystack_reference_returns_the_first_transaction() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/transaction/initialize":
            return httpx.Response(
                400, json={"status": False, "message": "Duplicate Transaction Reference"}
            )
        return httpx.Response(
            200,
            json={
                "status": True,
                "data": {
                    "reference": "velo-payment-1",
                    "status": "abandoned",
                    "amount": 100,
                    "currency": "NGN",
                },
            },
        )

    intent = await paystack_with(handler).create_intent(
        amount=100, currency="NGN", idempotency_key="velo-payment-1", metadata={}, email="a@b.ng"
    )

    assert intent.id == "velo-payment-1"
    assert intent.status is IntentStatus.REQUIRES_PAYMENT


# ── Selection and fingerprints ────────────────────────────────────────────────


def test_the_provider_is_chosen_by_currency_with_a_default() -> None:
    stripe_provider = stripe_with(None)
    paystack_provider = paystack_with(None)
    providers = PaymentProviders(
        {"stripe": stripe_provider, "paystack": paystack_provider},
        default="stripe",
        by_currency={"ngn": "paystack"},
    )

    assert providers.for_currency("NGN") is paystack_provider
    assert providers.for_currency("USD") is stripe_provider


def test_an_unconfigured_provider_is_unavailable_not_a_crash() -> None:
    with pytest.raises(PaymentsUnavailableError) as caught:
        PaymentProviders({}, default="stripe").for_currency("USD")
    assert caught.value.status_code == 503


def test_request_fingerprints_depend_on_method_path_and_exact_body() -> None:
    base = request_fingerprint("POST", "/api/v1/checkout", b'{"email":"a@b.c"}')

    assert base == request_fingerprint("post", "/api/v1/checkout", b'{"email":"a@b.c"}')
    assert base != request_fingerprint("POST", "/api/v1/checkout", b'{"email":"a@b.d"}')
    assert base != request_fingerprint("POST", "/api/v1/checkoutx", b'{"email":"a@b.c"}')
    # Length-prefixed: moving bytes between parts cannot collide.
    assert request_fingerprint("POST", "/a", b"b") != request_fingerprint("POST", "/ab", b"")
