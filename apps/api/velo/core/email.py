"""Outbound email: the message, and the request path's :class:`Mailer`.

Customer email — receipts, shipping, the welcome and verification emails — is
sent by the worker from the outbox (velo/emails/service.py), retried until
delivered. The request path sends only emails that carry a short-lived
credential the person is waiting for (password reset, lockout, staff invite),
through ``emails.transport.TransportMailer``: Resend in production, SMTP to
MailHog in development (http://localhost:8025).

A send that fails is logged, never raised into the request: a customer whose
registration succeeded must not see an error because the mail server hiccuped.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol


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
