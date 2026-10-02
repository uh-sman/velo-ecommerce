"""The sandbox provider's "card form" — mounted only when ``VELO_PAYMENT_SANDBOX`` is on.

``POST /sandbox/confirm`` is what Stripe.js's ``confirmPayment`` is to Stripe:
the browser holding the intent's client secret says how the payment went.
The resulting event then takes the real webhook path — verified, stored once,
processed by the worker — so an E2E order is created exactly as a real one is.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from velo.api.deps import JobsDep, PaymentServiceDep, ProvidersDep
from velo.core.errors import NotFoundError, ValidationError
from velo.core.jobs import PROCESS_PAYMENT_EVENT_JOB
from velo.domains.payments.provider import ProviderError, SignatureError
from velo.domains.payments.sandbox import SandboxProvider

router = APIRouter(prefix="/sandbox", tags=["sandbox"])


class ConfirmRequest(BaseModel):
    client_secret: str = Field(min_length=10, max_length=200)
    outcome: Literal["succeed", "decline"]


class ConfirmResponse(BaseModel):
    status: str
    failure_message: str | None = None


@router.post("/confirm", response_model=ConfirmResponse, summary="Pay a sandbox intent")
async def confirm(
    body: ConfirmRequest,
    providers: ProvidersDep,
    payments: PaymentServiceDep,
    jobs: JobsDep,
) -> ConfirmResponse:
    if not providers.configured("sandbox"):
        raise NotFoundError()
    provider = providers.get("sandbox")
    assert isinstance(provider, SandboxProvider)
    intent_id = body.client_secret.split("_secret_", 1)[0]
    try:
        intent, raw, signature = await provider.confirm(intent_id, body.client_secret, body.outcome)
        event = provider.verify_webhook(raw, signature)
    except (ProviderError, SignatureError) as exc:
        raise ValidationError("This payment cannot be confirmed.") from exc
    event_id = await payments.record_webhook("sandbox", event)
    if event_id is not None:
        await jobs.enqueue(PROCESS_PAYMENT_EVENT_JOB, str(event_id))
    return ConfirmResponse(status=intent.status.value, failure_message=intent.failure_message)
