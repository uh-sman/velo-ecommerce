"""Token primitives: signed JWTs, opaque random tokens, and their hashes.

No HTTP and no database here — the identity service decides what a token
means; this module only makes and checks them.

Access tokens are JWTs (ADR-008): verifying one is a signature check, with no
datastore read on the hot path. Refresh tokens are opaque random strings stored
only as a SHA-256 hash, so a database dump yields no working session.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import jwt

ALGORITHM = "HS256"
ISSUER = "velo"

TokenType = Literal["access", "verify_email", "password_reset"]


class InvalidTokenError(Exception):
    """Bad signature, wrong type, expired, or malformed. Deliberately not more specific."""


@dataclass(frozen=True, slots=True)
class AccessClaims:
    user_id: uuid.UUID
    role: str
    session_id: uuid.UUID  # the refresh-token family this access token was issued under
    expires_at: datetime


def _now() -> datetime:
    return datetime.now(UTC)


def encode_token(
    token_type: TokenType,
    subject: uuid.UUID,
    secret: str,
    ttl: timedelta,
    **claims: Any,
) -> str:
    now = _now()
    payload = {
        "iss": ISSUER,
        "sub": str(subject),
        "typ": token_type,
        "iat": now,
        "exp": now + ttl,
        "jti": secrets.token_hex(8),
        **claims,
    }
    return jwt.encode(payload, secret, algorithm=ALGORITHM)


def decode_token(
    token: str, token_type: TokenType, secret: str, *, verify_expiry: bool = True
) -> dict[str, Any]:
    """Verify and decode. The ``typ`` claim is checked so that, say, an
    email-verification token can never be presented as an access token."""
    try:
        payload: dict[str, Any] = jwt.decode(
            token,
            secret,
            algorithms=[ALGORITHM],  # never taken from the token header
            issuer=ISSUER,
            options={"require": ["exp", "sub", "typ"], "verify_exp": verify_expiry},
        )
    except jwt.PyJWTError as exc:
        raise InvalidTokenError(str(exc)) from exc
    if payload.get("typ") != token_type:
        raise InvalidTokenError("wrong token type")
    return payload


def create_access_token(
    user_id: uuid.UUID, role: str, session_id: uuid.UUID, secret: str, ttl: timedelta
) -> str:
    return encode_token("access", user_id, secret, ttl, role=role, sid=str(session_id))


def decode_access_token(token: str, secret: str, *, verify_expiry: bool = True) -> AccessClaims:
    payload = decode_token(token, "access", secret, verify_expiry=verify_expiry)
    try:
        return AccessClaims(
            user_id=uuid.UUID(payload["sub"]),
            role=str(payload["role"]),
            session_id=uuid.UUID(payload["sid"]),
            expires_at=datetime.fromtimestamp(payload["exp"], UTC),
        )
    except (KeyError, ValueError) as exc:
        raise InvalidTokenError("malformed access token") from exc


def new_opaque_token() -> str:
    """256 bits from the OS CSPRNG, URL-safe."""
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    """SHA-256, hex. Fine for high-entropy random tokens (not for passwords)."""
    return hashlib.sha256(token.encode()).hexdigest()


def fingerprint(value: str) -> str:
    """A short digest that changes whenever ``value`` does.

    Embedded in single-use tokens: a password-reset token carries the
    fingerprint of the password hash it was issued against, so the moment the
    password changes, every outstanding reset token stops working — single use,
    without a table of used tokens.
    """
    return hashlib.sha256(value.encode()).hexdigest()[:32]


def constant_time_equals(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())
