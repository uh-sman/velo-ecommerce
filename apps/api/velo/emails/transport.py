"""Getting a rendered email out: SMTP (MailHog in development) or Resend (production).

Unlike the request-path :class:`~velo.core.email.Mailer`, which logs and
swallows failures so a sign-up never errors on a mail-server hiccup, a
transport *raises* :class:`TransportError` — the worker relies on that to
retry the outbox event, and the email log to record why.

Resend: ``POST /emails`` with HTML, text, headers and base64 attachments;
the response's id is stored, and the delivery webhook (``/webhooks/resend``)
later reports delivered, bounced or complained against it.
"""

from __future__ import annotations

import base64
from email.message import EmailMessage as MimeMessage
from email.utils import make_msgid
from typing import Protocol

import aiosmtplib
import httpx

from velo.core.config import Settings
from velo.core.email import EmailMessage
from velo.core.logging import get_logger

logger = get_logger(__name__)


class TransportError(Exception):
    def __init__(self, message: str, *, retryable: bool = True) -> None:
        super().__init__(message)
        self.retryable = retryable


class Transport(Protocol):
    """``core.email.InMemoryMailer`` is one too, for tests."""

    name: str

    async def send(self, message: EmailMessage) -> str:
        """Send; return the provider's message id."""
        ...


class SmtpTransport:
    name = "smtp"

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    async def send(self, message: EmailMessage) -> str:
        mime = MimeMessage()
        mime["From"] = self._settings.email_from
        mime["To"] = message.to
        mime["Subject"] = message.subject
        message_id = make_msgid(domain="velo.local")
        mime["Message-ID"] = message_id
        for name, value in message.headers.items():
            mime[name] = value
        mime.set_content(message.text)
        if message.html:
            mime.add_alternative(message.html, subtype="html")
        for attachment in message.attachments:
            maintype, _, subtype = attachment.mime_type.partition("/")
            mime.add_attachment(
                attachment.content, maintype=maintype, subtype=subtype, filename=attachment.filename
            )
        password = self._settings.smtp_password
        try:
            await aiosmtplib.send(
                mime,
                hostname=self._settings.smtp_host,
                port=self._settings.smtp_port,
                username=self._settings.smtp_username,
                password=password.get_secret_value() if password else None,
                start_tls=self._settings.smtp_use_tls,
                timeout=10,
            )
        except (aiosmtplib.SMTPException, OSError) as exc:
            raise TransportError(f"SMTP: {exc}") from exc
        return message_id


class ResendTransport:
    name = "resend"

    def __init__(
        self,
        settings: Settings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._settings = settings
        self._client = httpx.AsyncClient(
            base_url=settings.resend_api_base,
            headers={
                "Authorization": f"Bearer {settings.resend_api_key.get_secret_value()}",
            },
            timeout=10.0,
            transport=transport,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def send(self, message: EmailMessage) -> str:
        body: dict[str, object] = {
            "from": self._settings.email_from,
            "to": [message.to],
            "subject": message.subject,
            "text": message.text,
        }
        if message.html:
            body["html"] = message.html
        if message.headers:
            body["headers"] = message.headers
        if message.attachments:
            body["attachments"] = [
                {"filename": a.filename, "content": base64.b64encode(a.content).decode()}
                for a in message.attachments
            ]
        try:
            response = await self._client.post("/emails", json=body)
        except httpx.HTTPError as exc:
            raise TransportError(f"Resend unreachable: {exc}") from exc
        if response.status_code >= 400:
            # 4xx other than rate limiting: the request is wrong; retrying will not help.
            retryable = response.status_code == 429 or response.status_code >= 500
            raise TransportError(
                f"Resend {response.status_code}: {response.text[:200]}", retryable=retryable
            )
        return str(response.json()["id"])


def build_transport(settings: Settings) -> Transport:
    """Resend when a key is configured; SMTP otherwise."""
    if settings.resend_api_key.get_secret_value():
        return ResendTransport(settings)
    return SmtpTransport(settings)


class TransportMailer:
    """The request path's :class:`~velo.core.email.Mailer` over the configured transport.

    Account emails that carry a short-lived credential (password reset, lockout,
    staff invites) are sent inline, and must go out the same way as everything
    else — through Resend in production, not to an SMTP host that is not there.
    A failure is logged and swallowed, as the Mailer protocol requires.
    """

    def __init__(self, transport: Transport) -> None:
        self._transport = transport

    async def send(self, message: EmailMessage) -> str | None:
        try:
            provider_id = await self._transport.send(message)
        except TransportError:
            # The subject names the kind of email; the address is not logged.
            logger.warning(
                "email_send_failed",
                subject=message.subject,
                transport=self._transport.name,
                exc_info=True,
            )
            return None
        logger.info("email_sent", subject=message.subject, transport=self._transport.name)
        return provider_id

    async def aclose(self) -> None:
        close = getattr(self._transport, "aclose", None)
        if close is not None:
            await close()
