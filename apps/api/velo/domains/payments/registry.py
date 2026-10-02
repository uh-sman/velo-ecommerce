"""Which provider takes a payment — resolved server-side, by currency (§4).

A provider is available only when its keys are configured. Asking for one
that is not is :class:`PaymentsUnavailableError` (503): the checkout keeps its
reservation and the customer is asked to try again shortly.
"""

from __future__ import annotations

from collections.abc import Mapping

import httpx

from velo.core.config import Settings
from velo.domains.payments.exceptions import PaymentsUnavailableError
from velo.domains.payments.paystack import PaystackProvider
from velo.domains.payments.provider import PaymentProvider
from velo.domains.payments.stripe import StripeProvider


class PaymentProviders:
    def __init__(
        self,
        providers: Mapping[str, PaymentProvider],
        *,
        default: str = "stripe",
        by_currency: Mapping[str, str] | None = None,
    ) -> None:
        self._providers = dict(providers)
        self._default = default
        self._by_currency = {code.upper(): name for code, name in (by_currency or {}).items()}

    def for_currency(self, currency: str) -> PaymentProvider:
        return self.get(self._by_currency.get(currency.upper(), self._default))

    def get(self, name: str) -> PaymentProvider:
        provider = self._providers.get(name)
        if provider is None:
            raise PaymentsUnavailableError(
                "Payments are temporarily unavailable. Please try again in a few minutes."
            )
        return provider

    def configured(self, name: str) -> bool:
        return name in self._providers

    async def aclose(self) -> None:
        for provider in self._providers.values():
            await provider.aclose()


def build_providers(
    settings: Settings, transport: httpx.AsyncBaseTransport | None = None
) -> PaymentProviders:
    providers: dict[str, PaymentProvider] = {}
    if settings.stripe_secret_key.get_secret_value():
        providers["stripe"] = StripeProvider(
            secret_key=settings.stripe_secret_key.get_secret_value(),
            publishable_key=settings.stripe_publishable_key,
            webhook_secret=settings.stripe_webhook_secret.get_secret_value(),
            api_base=settings.stripe_api_base,
            transport=transport,
        )
    if settings.paystack_secret_key.get_secret_value():
        providers["paystack"] = PaystackProvider(
            secret_key=settings.paystack_secret_key.get_secret_value(),
            public_key=settings.paystack_public_key,
            api_base=settings.paystack_api_base,
            transport=transport,
        )
    return PaymentProviders(
        providers,
        default=settings.payment_default_provider,
        by_currency=settings.payment_currency_providers,
    )
