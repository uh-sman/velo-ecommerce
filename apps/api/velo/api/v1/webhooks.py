"""/webhooks — where orders actually get created (PAYMENTS-AND-CHECKOUT.md §6).

Three defences, in order:

1. **Verify.** The signature is checked against the raw request body, before
   anything is parsed. A bad signature is 400 and nothing is written.
2. **Deduplicate.** The event is stored under ``UNIQUE (provider, event id)``;
   a repeat delivery is acknowledged and dropped.
3. **Acknowledge fast.** The work happens in the worker. Providers retry slow
   endpoints aggressively, and a retry arriving while the first delivery is
   still being handled is exactly the duplicate this design avoids.

CSRF does not apply here (api/csrf.py): the signature authenticates.
"""

from __future__ import annotations

import hashlib
import hmac

from fastapi import APIRouter, Request
from pydantic import ValidationError as PydanticValidationError

from velo.api.deps import (
    ClientDep,
    FulfilmentServiceDep,
    JobsDep,
    PaymentServiceDep,
    ProvidersDep,
    SettingsDep,
)
from velo.core.errors import DomainError, NotFoundError, ValidationError
from velo.core.jobs import PROCESS_PAYMENT_EVENT_JOB
from velo.core.logging import get_logger
from velo.domains.orders.views import TrackingUpdate
from velo.domains.payments.exceptions import WebhookSignatureError
from velo.domains.payments.provider import SignatureError

logger = get_logger(__name__)

router = APIRouter(prefix="/webhooks", tags=["webhooks"])


async def _receive(
    provider_name: str,
    signature: str,
    request: Request,
    providers: ProvidersDep,
    payments: PaymentServiceDep,
    jobs: JobsDep,
    client: ClientDep,
) -> dict[str, bool]:
    if not providers.configured(provider_name):
        raise NotFoundError()
    raw = await request.body()  # the exact bytes the signature covers
    try:
        event = providers.get(provider_name).verify_webhook(raw, signature)
    except SignatureError as exc:
        logger.warning(
            "webhook_invalid_signature", provider=provider_name, ip=client.ip, reason=str(exc)
        )
        raise WebhookSignatureError("Invalid signature.") from exc

    event_id = await payments.record_webhook(provider_name, event)
    if event_id is None:
        logger.info("webhook_duplicate", provider=provider_name, provider_event=event.id)
        return {"received": True}
    await jobs.enqueue(PROCESS_PAYMENT_EVENT_JOB, str(event_id))
    logger.info(
        "webhook_received", provider=provider_name, provider_event=event.id, type=event.type
    )
    return {"received": True}


@router.post("/stripe", summary="Stripe events (signed)")
async def stripe_webhook(
    request: Request,
    providers: ProvidersDep,
    payments: PaymentServiceDep,
    jobs: JobsDep,
    client: ClientDep,
) -> dict[str, bool]:
    signature = request.headers.get("stripe-signature", "")
    return await _receive("stripe", signature, request, providers, payments, jobs, client)


@router.post("/paystack", summary="Paystack events (signed)")
async def paystack_webhook(
    request: Request,
    providers: ProvidersDep,
    payments: PaymentServiceDep,
    jobs: JobsDep,
    client: ClientDep,
) -> dict[str, bool]:
    signature = request.headers.get("x-paystack-signature", "")
    return await _receive("paystack", signature, request, providers, payments, jobs, client)


# ── Carrier tracking ──────────────────────────────────────────────────────────

# Carrier vocabulary → a parcel's status. Absent: informational, acknowledged only.
_TRACKING_STATUS = {
    "in_transit": "in_transit",
    "out_for_delivery": "in_transit",
    "delivered": "delivered",
    "failed": "failed",
    "exception": "failed",
}


@router.post("/tracking", summary="Carrier tracking updates (HMAC-SHA256 signed)")
async def tracking_webhook(
    request: Request,
    settings: SettingsDep,
    fulfilment: FulfilmentServiceDep,
    client: ClientDep,
) -> dict[str, bool]:
    """``X-Velo-Signature`` is the hex HMAC-SHA256 of the raw body under the shared secret.

    Every parcel with the tracking number moves on. A status a parcel cannot
    move to (say, delivered twice) is logged and acknowledged — refusing it
    would only make the carrier retry.
    """
    secret = settings.tracking_webhook_secret.get_secret_value()
    if not secret:
        raise NotFoundError()
    raw = await request.body()
    expected = hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, request.headers.get("x-velo-signature", "")):
        logger.warning("webhook_invalid_signature", provider="tracking", ip=client.ip)
        raise WebhookSignatureError("Invalid signature.")
    try:
        update = TrackingUpdate.model_validate_json(raw)
    except PydanticValidationError as exc:
        raise ValidationError("Unreadable tracking update.") from exc

    status = _TRACKING_STATUS.get(update.status)
    if status is None:
        return {"received": True}
    for parcel in await fulfilment.by_tracking(update.tracking_number):
        try:
            await fulfilment.update_shipment(
                parcel.id, status, actor=None, occurred_at=update.occurred_at
            )
        except DomainError as exc:
            logger.info(
                "tracking_update_ignored",
                fulfilment_id=str(parcel.id),
                status=status,
                reason=str(exc),
            )
    return {"received": True}
