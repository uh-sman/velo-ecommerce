"""Email links and email delivery (PLANNING.md Phase 12).

- ``POST /email/unsubscribe`` — the unsubscribe link and the one-click
  ``List-Unsubscribe-Post`` that Gmail and Apple Mail send. The signed token
  is the credential, so CSRF does not apply (api/csrf.py exempts ``/email/``).
- ``POST /cart/recover`` — a reminder's link back to a guest cart: the cart
  moves to the browser that opened it (a new cookie token; only its hash is
  stored, so the old one cannot be handed back).
- ``GET/PATCH /account/preferences`` — a signed-in customer's email choices.
- ``POST /webhooks/resend`` — delivery, bounce and complaint events, signed by
  Svix (Resend's webhook signer) over the raw body.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import time
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Query, Request, Response
from pydantic import BaseModel, ConfigDict, StringConstraints

from velo.api.cookies import set_cart_cookie
from velo.api.deps import CurrentUserDep, SessionDep, SettingsDep
from velo.core.errors import ConflictError, NotFoundError, ValidationError
from velo.core.logging import get_logger
from velo.core.security import new_opaque_token
from velo.domains.cart.models import Cart
from velo.domains.cart.service import hash_token
from velo.domains.identity.models import User
from velo.domains.payments.exceptions import WebhookSignatureError
from velo.emails.models import EmailPreference
from velo.emails.service import record_delivery, set_cart_reminders
from velo.emails.tokens import read_cart_token, read_unsubscribe_token

logger = get_logger(__name__)
router = APIRouter(tags=["email"])

Token = Annotated[str, StringConstraints(min_length=10, max_length=400)]
SVIX_TOLERANCE_SECONDS = 5 * 60


class TokenBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    token: Token


class UnsubscribedView(BaseModel):
    email: str
    kind: str
    unsubscribed: bool


@router.post(
    "/email/unsubscribe",
    response_model=UnsubscribedView,
    summary="Unsubscribe by signed link (one-click capable)",
)
async def unsubscribe(
    request: Request,
    session: SessionDep,
    settings: SettingsDep,
    token: Annotated[str | None, Query(max_length=400)] = None,
) -> UnsubscribedView:
    if token is None:
        # The storefront page sends JSON; a mail client's one-click sends a form.
        try:
            body: Any = await request.json()
            token = str(body.get("token", "")) if isinstance(body, dict) else ""
        except ValueError:
            token = ""
    found = read_unsubscribe_token(settings.secret_key.get_secret_value(), token or "")
    if found is None:
        raise ValidationError("This unsubscribe link is not valid.")
    email, kind = found
    if kind == "cart_recovery":
        await set_cart_reminders(session, email, enabled=False)
    logger.info("email_unsubscribed", kind=kind)
    return UnsubscribedView(email=email, kind=kind, unsubscribed=True)


@router.post("/cart/recover", status_code=204, summary="Restore a cart from a reminder link")
async def recover_cart(body: TokenBody, session: SessionDep, settings: SettingsDep) -> Response:
    cart_id = read_cart_token(settings.secret_key.get_secret_value(), body.token)
    if cart_id is None:
        raise ValidationError("This cart link is not valid.")
    cart = await session.get(Cart, cart_id, with_for_update=True)
    if cart is None or cart.status not in ("active", "abandoned"):
        raise NotFoundError("This cart is no longer available.")
    if cart.user_id is not None:
        raise ConflictError("Sign in to see this cart.")
    token = new_opaque_token()
    cart.guest_token = hash_token(token)
    cart.status = "active"
    await session.commit()
    response = Response(status_code=204)
    set_cart_cookie(response, token, settings)
    return response


class PreferencesView(BaseModel):
    order_updates: bool  # always true: receipts and shipping cannot be turned off
    cart_reminders: bool
    marketing: bool


class PreferencesPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cart_reminders: bool | None = None
    marketing: bool | None = None


async def _preferences(session: SessionDep, user: User) -> PreferencesView:
    pref = await session.get(EmailPreference, user.email)
    return PreferencesView(
        order_updates=True,
        cart_reminders=pref.cart_reminders if pref else True,
        marketing=user.marketing_opt_in,
    )


@router.get("/account/preferences", response_model=PreferencesView, summary="Email choices")
async def get_preferences(user: CurrentUserDep, session: SessionDep) -> PreferencesView:
    row = await session.get(User, user.id)
    assert row is not None
    return await _preferences(session, row)


@router.patch(
    "/account/preferences", response_model=PreferencesView, summary="Change email choices"
)
async def update_preferences(
    body: PreferencesPatch, user: CurrentUserDep, session: SessionDep
) -> PreferencesView:
    row = await session.get(User, user.id, with_for_update=True)
    assert row is not None
    if body.marketing is not None:
        row.marketing_opt_in = body.marketing
    await session.commit()
    if body.cart_reminders is not None:
        await set_cart_reminders(session, row.email, body.cart_reminders)
    return await _preferences(session, row)


# ── Resend delivery webhook ───────────────────────────────────────────────────


def verify_svix(
    secret: str, headers: dict[str, str], body: bytes, now: float | None = None
) -> None:
    """Svix's scheme: HMAC-SHA256 of ``id.timestamp.body`` under the base64 secret."""
    msg_id = headers.get("svix-id", "")
    timestamp = headers.get("svix-timestamp", "")
    signatures = headers.get("svix-signature", "")
    if not (msg_id and timestamp and signatures):
        raise WebhookSignatureError("Missing signature headers.")
    try:
        sent = int(timestamp)
    except ValueError as exc:
        raise WebhookSignatureError("Bad timestamp.") from exc
    if abs((now or time.time()) - sent) > SVIX_TOLERANCE_SECONDS:
        raise WebhookSignatureError("Stale signature.")
    key = base64.b64decode(secret.removeprefix("whsec_"))
    expected = base64.b64encode(
        hmac.new(key, f"{msg_id}.{timestamp}.".encode() + body, hashlib.sha256).digest()
    ).decode()
    for candidate in signatures.split():
        version, _, value = candidate.partition(",")
        if version == "v1" and hmac.compare_digest(value, expected):
            return
    raise WebhookSignatureError("Invalid signature.")


def sign_svix(secret: str, msg_id: str, timestamp: int, body: bytes) -> str:
    """The ``svix-signature`` header value — what Resend sends, and what tests forge."""
    key = base64.b64decode(secret.removeprefix("whsec_"))
    digest = hmac.new(key, f"{msg_id}.{timestamp}.".encode() + body, hashlib.sha256).digest()
    return f"v1,{base64.b64encode(digest).decode()}"


@router.post("/webhooks/resend", summary="Resend delivery events (Svix-signed)")
async def resend_webhook(
    request: Request, session: SessionDep, settings: SettingsDep
) -> dict[str, bool]:
    secret = settings.resend_webhook_secret.get_secret_value()
    if not secret:
        raise NotFoundError()
    raw = await request.body()
    verify_svix(secret, {k.lower(): v for k, v in request.headers.items()}, raw)
    event = await request.json()
    data = event.get("data") or {}
    message_id = str(data.get("email_id") or "")
    if message_id:
        at = datetime.now(UTC)
        known = await record_delivery(session, message_id, str(event.get("type", "")), at)
        if not known:
            logger.info("resend_event_unknown_message", type=event.get("type"))
    return {"received": True}
