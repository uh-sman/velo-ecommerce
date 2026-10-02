"""Outbound email.

Sent inline over SMTP for now — to MailHog in development
(http://localhost:8025). Phase 12 moves sending to a background worker behind
the outbox; callers use the :class:`Mailer` protocol and will not change.

A send that fails is logged, never raised into the request: a customer whose
registration succeeded must not see an error because the mail server hiccuped.
"""

from __future__ import annotations

from dataclasses import dataclass
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
    text: str
    attachments: tuple[Attachment, ...] = ()


class Mailer(Protocol):
    async def send(self, message: EmailMessage) -> None: ...


class SmtpMailer:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    async def send(self, message: EmailMessage) -> None:
        mime = MimeMessage()
        mime["From"] = self._settings.email_from
        mime["To"] = message.to
        mime["Subject"] = message.subject
        mime.set_content(message.text)
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
            return
        logger.info("email_sent", subject=message.subject)


class InMemoryMailer:
    """Collects messages instead of sending them. For tests."""

    def __init__(self) -> None:
        self.outbox: list[EmailMessage] = []

    async def send(self, message: EmailMessage) -> None:
        self.outbox.append(message)
