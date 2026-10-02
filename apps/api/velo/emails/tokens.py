"""Signed links in emails: unsubscribe, and cart recovery.

HMACs under the server secret, each scoped by a purpose string so one kind of
token can never be used as another. Nothing is stored; rotating the secret
invalidates every link. Unsubscribe tokens do not expire — an unsubscribe link
must work however old the email is.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import uuid


def _sign(secret: str, message: str) -> str:
    return hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest()[:32]


def _pack(*parts: str) -> str:
    return base64.urlsafe_b64encode("|".join(parts).encode()).decode().rstrip("=")


def _unpack(token: str) -> list[str]:
    padded = token + "=" * (-len(token) % 4)
    return base64.urlsafe_b64decode(padded.encode()).decode().split("|")


def unsubscribe_token(secret: str, email: str, kind: str) -> str:
    return _pack(email.lower(), kind, _sign(secret, f"unsubscribe:{email.lower()}:{kind}"))


def read_unsubscribe_token(secret: str, token: str) -> tuple[str, str] | None:
    """``(email, kind)`` if the token is genuine."""
    try:
        email, kind, signature = _unpack(token)
    except (ValueError, UnicodeDecodeError):
        return None
    expected = _sign(secret, f"unsubscribe:{email}:{kind}")
    return (email, kind) if hmac.compare_digest(expected, signature) else None


def cart_token(secret: str, cart_id: uuid.UUID) -> str:
    return _pack(str(cart_id), _sign(secret, f"cart-recovery:{cart_id}"))


def read_cart_token(secret: str, token: str) -> uuid.UUID | None:
    try:
        cart_id, signature = _unpack(token)
        parsed = uuid.UUID(cart_id)
    except (ValueError, UnicodeDecodeError):
        return None
    expected = _sign(secret, f"cart-recovery:{parsed}")
    return parsed if hmac.compare_digest(expected, signature) else None
