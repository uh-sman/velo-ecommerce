"""Outbound email.

Sent inline over SMTP for now — to MailHog in development
(http://localhost:8025). Phase 12 moves sending to a background worker behind
the outbox; callers use the :class:`Mailer` protocol and will not change.

A send that fails is logged, never raised into the request: a customer whose
registration succeeded must not see an error because the mail server hiccuped.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from email.message import EmailMessage as MimeMessage
from typing import Protocol

import aiosmtplib

from velo.core.config import Settings
from velo.core.logging import get_logger

logger = get_logger(__name__)


@dataclass(frozen=True, slots=True)
class Attachment:
    filename: str
    content: bytes
    mime_type: str = "application/pdf"


@dataclass(frozen=True, slots=True)
class EmailMessage:
    to: str
    subject: str
    text: str  # always: the plain-text alternative every client can read
    html: str | None = None
    headers: dict[str, str] = field(default_factory=dict)
    attachments: tuple[Attachment, ...] = ()


class Mailer(Protocol):
    """The request path's sender: logs and swallows failures (see the module docstring)."""

    async def send(self, message: EmailMessage) -> str | None: ...


class SmtpMailer:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    async def send(self, message: EmailMessage) -> str | None:
        mime = MimeMessage()
        mime["From"] = self._settings.email_from
        mime["To"] = message.to
        mime["Subject"] = message.subject
        for name, value in message.headers.items():
            mime[name] = value
        mime.set_content(message.text)
        if message.html:
            mime.add_alternative(message.html, subtype="html")
        for attachment in message.attachments:
            maintype, _, subtype = attachment.mime_type.partition("/")
            mime.add_attachment(
                attachment.content,
                maintype=maintype,
                subtype=subtype,
                filename=attachment.filename,
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
        except (aiosmtplib.SMTPException, OSError):
            # The subject names the kind of email; the address is not logged.
            logger.warning("email_send_failed", subject=message.subject, exc_info=True)
            return None
        logger.info("email_sent", subject=message.subject)
        return None


class InMemoryMailer:
    """Collects messages instead of sending them. For tests.

    Also a worker transport (velo/emails/transport.py): set ``fail_next`` to
    make the next send raise, as a provider outage would.
    """

    name = "memory"

    def __init__(self) -> None:
        self.outbox: list[EmailMessage] = []
        self.fail_next: Exception | None = None

    async def send(self, message: EmailMessage) -> str:
        if self.fail_next is not None:
            error, self.fail_next = self.fail_next, None
            raise error
        self.outbox.append(message)
        return f"mem-{len(self.outbox)}"
