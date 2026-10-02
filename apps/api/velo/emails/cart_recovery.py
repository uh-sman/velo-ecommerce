"""Abandoned-cart recovery (PLANNING.md Phase 12): reminders at 1 hour, 24 hours, and 72 hours.

A cart is a candidate when it has items, has been idle for an hour, and we
know whose it is: the account's email, or the email a guest gave when they
started checkout. Each reminder is sent once (its dedupe key names the cart,
the activity it is about, and the step). Activity on the cart restarts the
sequence; buying empties the cart and ends it; unsubscribing ends it for
every cart of that address.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import column, func, select, table
from sqlalchemy.ext.asyncio import AsyncSession

from velo.core.config import Settings
from velo.core.logging import get_logger
from velo.emails.models import CartReminder
from velo.emails.service import EmailService
from velo.emails.tokens import cart_token
from velo.emails.transport import TransportError

logger = get_logger(__name__)

# Idle time before each reminder, from the cart's last change.
STEPS = (timedelta(hours=1), timedelta(hours=24), timedelta(hours=72))
BATCH = 200

_carts = table(
    "carts",
    column("id"),
    column("user_id"),
    column("guest_token"),
    column("status"),
    column("updated_at"),
)
_items = table("cart_items", column("cart_id"), column("variant_id"), column("quantity"))
_users = table("users", column("id"), column("email"), column("first_name"))
_checkouts = table("checkout_sessions", column("cart_id"), column("email"), column("created_at"))
_variants = table("product_variants", column("id"), column("product_id"), column("title"))
_products = table("products", column("id"), column("title"))


@dataclass(frozen=True, slots=True)
class Candidate:
    cart_id: uuid.UUID
    email: str
    first_name: str | None
    is_guest: bool
    updated_at: datetime


class CartRecovery:
    def __init__(self, session: AsyncSession, settings: Settings, emails: EmailService) -> None:
        self._session = session
        self._settings = settings
        self._emails = emails

    async def run(self, now: datetime | None = None) -> dict[str, int]:
        now = now or datetime.now(UTC)
        sent = skipped = failed = 0
        for candidate in await self._candidates(now):
            step = await self._due_step(candidate, now)
            if step is None:
                continue
            try:
                outcome = await self._emails.send(
                    "cart_recovery",
                    candidate.email,
                    {
                        "step": step,
                        "first_name": candidate.first_name,
                        "lines": await self._lines(candidate.cart_id),
                        "cart_url": self._cart_url(candidate),
                    },
                    dedupe_key=(
                        f"cart_recovery:{candidate.cart_id}:"
                        f"{candidate.updated_at.isoformat()}:{step}"
                    ),
                )
            except TransportError:
                failed += 1
                continue  # the step is not recorded: the next run tries again
            reminder = await self._session.get(CartReminder, candidate.cart_id)
            if reminder is not None:
                reminder.step = step
                reminder.last_sent_at = now
                await self._session.commit()
            if outcome.status == "sent":
                sent += 1
            else:
                skipped += 1
        return {"sent": sent, "skipped": skipped, "failed": failed}

    async def _candidates(self, now: datetime) -> list[Candidate]:
        latest_checkout = (
            select(_checkouts.c.email)
            .where(_checkouts.c.cart_id == _carts.c.id)
            .order_by(_checkouts.c.created_at.desc())
            .limit(1)
            .scalar_subquery()
        )
        has_items = select(_items.c.cart_id).where(_items.c.cart_id == _carts.c.id).exists()
        rows = await self._session.execute(
            select(
                _carts.c.id,
                func.coalesce(_users.c.email, latest_checkout),
                _users.c.first_name,
                _carts.c.user_id.is_(None),
                _carts.c.updated_at,
            )
            .select_from(_carts)
            .outerjoin(_users, _users.c.id == _carts.c.user_id)
            .where(
                _carts.c.status.in_(("active", "abandoned")),
                _carts.c.updated_at < now - STEPS[0],
                _carts.c.updated_at > now - timedelta(days=7),  # past the sequence: leave it be
                has_items,
            )
            .order_by(_carts.c.updated_at)
            .limit(BATCH)
        )
        return [
            Candidate(cart_id, email, first_name, bool(guest), updated_at)
            for cart_id, email, first_name, guest, updated_at in rows.all()
            if email
        ]

    async def _due_step(self, candidate: Candidate, now: datetime) -> int | None:
        reminder = await self._session.get(CartReminder, candidate.cart_id, with_for_update=True)
        if reminder is None:
            reminder = CartReminder(
                cart_id=candidate.cart_id,
                email=candidate.email,
                step=0,
                activity_at=candidate.updated_at,
            )
            self._session.add(reminder)
        elif candidate.updated_at > reminder.activity_at:
            # The customer came back and changed the cart: a new sequence.
            reminder.step = 0
            reminder.activity_at = candidate.updated_at
            reminder.email = candidate.email
        await self._session.commit()
        if reminder.step >= len(STEPS):
            return None
        idle = now - candidate.updated_at
        return reminder.step + 1 if idle >= STEPS[reminder.step] else None

    async def _lines(self, cart_id: uuid.UUID) -> list[dict[str, object]]:
        rows = await self._session.execute(
            select(_products.c.title, _variants.c.title, _items.c.quantity)
            .select_from(_items)
            .join(_variants, _variants.c.id == _items.c.variant_id)
            .join(_products, _products.c.id == _variants.c.product_id)
            .where(_items.c.cart_id == cart_id)
        )
        return [
            {"title": title, "variant": variant, "quantity": quantity, "amount": None}
            for title, variant, quantity in rows.all()
        ]

    def _cart_url(self, candidate: Candidate) -> str:
        base = self._settings.storefront_url
        if candidate.is_guest:
            token = cart_token(self._settings.secret_key.get_secret_value(), candidate.cart_id)
            return f"{base}/cart/recover?token={token}"
        return f"{base}/cart"  # an account's cart follows the customer when they sign in
