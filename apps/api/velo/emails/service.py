"""Sending customer email exactly once (PLANNING.md Phase 12).

``EmailService.send`` is the one way the worker emails a customer:

1. **Exactly once.** The row for ``dedupe_key`` is claimed first. A key already
   sent (or delivered) is skipped, so an outbox event relayed twice emails
   once. A key that failed before is tried again.
2. **Preferences.** Marketing kinds are skipped for an address that opted out.
   Transactional kinds always go: the customer needs them.
3. **Rate limits per recipient.** A bug that loops must not flood an inbox:
   past the limit the email is skipped and logged.
4. **Render, send, record.** The provider's message id is stored for the
   delivery webhook. A transport failure is recorded and *raised*, so the
   outbox relay retries the event — and the dedupe row lets the retry through.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from velo.core.config import Settings
from velo.core.email import Attachment, EmailMessage
from velo.core.logging import get_logger
from velo.core.rate_limit import RateLimiter, Rule
from velo.db.session import open_session
from velo.domains.platform.settings import SettingsService
from velo.emails.models import EmailPreference, SentEmail
from velo.emails.render import KINDS, render
from velo.emails.tokens import unsubscribe_token
from velo.emails.transport import Transport, TransportError

logger = get_logger(__name__)

# Per recipient per hour. Transactional is generous — a busy customer can
# order, ship and refund in an hour — but a loop still stops.
TRANSACTIONAL_PER_RECIPIENT = Rule("email-transactional", 30, 60 * 60)
MARKETING_PER_RECIPIENT = Rule("email-marketing", 2, 24 * 60 * 60)


@dataclass(frozen=True, slots=True)
class Outcome:
    status: str  # sent | skipped | duplicate
    reason: str | None = None
    message_id: uuid.UUID | None = None


Sessions = Callable[[], AbstractAsyncContextManager[AsyncSession]]


class EmailService:
    """Holds no session of its own: each send opens short ones for the email log.

    The worker calls it from inside the outbox relay's transaction, whose row
    locks must not be released early — so the log is written beside it, never
    in it.
    """

    def __init__(
        self,
        settings: Settings,
        transport: Transport,
        limiter: RateLimiter | None,
        *,
        sessions: Sessions = open_session,
    ) -> None:
        self._settings = settings
        self._transport = transport
        self._limiter = limiter
        self._sessions = sessions

    async def send(
        self,
        kind: str,
        to: str,
        context: dict[str, Any],
        *,
        dedupe_key: str | None,
        user_id: uuid.UUID | None = None,
        attachments: tuple[Attachment, ...] = (),
    ) -> Outcome:
        spec = KINDS[kind]
        async with self._sessions() as session:
            row_id = await self._claim(session, kind, to, dedupe_key, user_id)
            if row_id is None:
                return Outcome("duplicate")

            if spec.category == "marketing" and not await self.allows(session, to, kind):
                await self._finish(session, row_id, status="skipped", skip_reason="unsubscribed")
                return Outcome("skipped", "unsubscribed", row_id)
            if self._limiter is not None:
                rule = (
                    MARKETING_PER_RECIPIENT
                    if spec.category == "marketing"
                    else TRANSACTIONAL_PER_RECIPIENT
                )
                allowed = await self._limiter.hit(rule, to.lower())
                if not allowed.allowed:
                    await self._finish(
                        session, row_id, status="skipped", skip_reason="rate_limited"
                    )
                    logger.warning("email_rate_limited", kind=kind)
                    return Outcome("skipped", "rate_limited", row_id)

            values = await SettingsService(session, self._settings).all()
            unsubscribe = None
            headers: dict[str, str] = {}
            if spec.category == "marketing":
                token = unsubscribe_token(self._settings.secret_key.get_secret_value(), to, kind)
                unsubscribe = f"{self._settings.storefront_url}/unsubscribe?token={token}"
                one_click = (
                    f"{self._settings.public_api_url}{self._settings.api_prefix}"
                    f"/email/unsubscribe?token={token}"
                )
                headers = {
                    "List-Unsubscribe": f"<{one_click}>",
                    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
                }
            rendered = render(
                kind,
                context,
                store=values["store"],
                texts=values["emails"],
                unsubscribe_url=unsubscribe,
            )
            await self._finish(session, row_id, subject=rendered.subject)

            try:
                provider_id = await self._transport.send(
                    EmailMessage(
                        to=to,
                        subject=rendered.subject,
                        html=rendered.html,
                        text=rendered.text,
                        headers=headers,
                        attachments=attachments,
                    )
                )
            except TransportError as exc:
                await self._finish(session, row_id, status="failed", error=str(exc)[:500])
                logger.warning("email_send_failed", kind=kind, retryable=exc.retryable)
                raise
            await self._finish(
                session,
                row_id,
                status="sent",
                provider=self._transport.name,
                provider_message_id=provider_id,
                sent_at=datetime.now(UTC),
            )
        logger.info("email_sent", kind=kind)
        return Outcome("sent", message_id=row_id)

    async def allows(self, session: AsyncSession, email: str, kind: str) -> bool:
        if kind != "cart_recovery":
            return True
        pref = await session.get(EmailPreference, email)
        return pref is None or pref.cart_reminders

    async def _claim(
        self,
        session: AsyncSession,
        kind: str,
        to: str,
        dedupe_key: str | None,
        user_id: uuid.UUID | None,
    ) -> uuid.UUID | None:
        """The row this send writes to; None if the key was already sent."""
        if dedupe_key is not None:
            existing = await session.scalar(
                select(SentEmail).where(SentEmail.dedupe_key == dedupe_key).with_for_update()
            )
            if existing is not None:
                if existing.status in ("sent", "delivered", "bounced", "complained", "skipped"):
                    await session.commit()
                    return None
                existing.status = "queued"
                existing.error = None
                await session.commit()
                return existing.id
        row_id = await session.scalar(
            insert(SentEmail)
            .values(kind=kind, to_email=to, subject="", dedupe_key=dedupe_key, user_id=user_id)
            .on_conflict_do_nothing(index_elements=["dedupe_key"])
            .returning(SentEmail.id)
        )
        await session.commit()
        return row_id

    @staticmethod
    async def _finish(session: AsyncSession, row_id: uuid.UUID, **fields: Any) -> None:
        await session.execute(update(SentEmail).where(SentEmail.id == row_id).values(**fields))
        await session.commit()


async def set_cart_reminders(session: AsyncSession, email: str, enabled: bool) -> None:
    await session.execute(
        insert(EmailPreference)
        .values(email=email, cart_reminders=enabled)
        .on_conflict_do_update(
            index_elements=["email"],
            set_={"cart_reminders": enabled, "updated_at": datetime.now(UTC)},
        )
    )
    await session.commit()


async def record_delivery(
    session: AsyncSession, provider_message_id: str, event: str, at: datetime
) -> bool:
    """Apply a provider delivery event. False if the message is not ours."""
    changes: dict[str, dict[str, Any]] = {
        "email.delivered": {"status": "delivered", "delivered_at": at},
        "email.bounced": {"status": "bounced", "bounced_at": at},
        "email.complained": {"status": "complained"},
    }
    fields = changes.get(event, {})
    if not fields:
        return True  # sent, opened, clicked: acknowledged, not tracked
    result = await session.execute(
        update(SentEmail)
        .where(SentEmail.provider_message_id == provider_message_id)
        .values(**fields)
        .returning(SentEmail.to_email)
    )
    rows = result.all()
    if rows and event in ("email.bounced", "email.complained"):
        # A complaint is an unsubscribe; a hard bounce stops marketing too.
        for (email,) in rows:
            await session.execute(
                insert(EmailPreference)
                .values(email=email, cart_reminders=False)
                .on_conflict_do_update(
                    index_elements=["email"],
                    set_={"cart_reminders": False, "updated_at": at},
                )
            )
    await session.commit()
    return bool(rows)
