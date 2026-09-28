"""Token primitives (velo/core/security.py)."""

from __future__ import annotations

import base64
import json
import uuid
from datetime import timedelta

import jwt
import pytest

from tests.conftest import TEST_ENV
from velo.core.security import (
    InvalidTokenError,
    create_access_token,
    decode_access_token,
    decode_token,
    encode_token,
    fingerprint,
    hash_token,
    new_opaque_token,
)

SECRET = TEST_ENV["VELO_SECRET_KEY"]
USER = uuid.uuid4()
SESSION = uuid.uuid4()


def test_access_token_round_trip() -> None:
    token = create_access_token(USER, "admin", SESSION, SECRET, timedelta(minutes=15))

    claims = decode_access_token(token, SECRET)

    assert (claims.user_id, claims.role, claims.session_id) == (USER, "admin", SESSION)


def test_expired_tokens_are_refused_unless_expiry_is_explicitly_ignored() -> None:
    token = create_access_token(USER, "customer", SESSION, SECRET, timedelta(seconds=-1))

    with pytest.raises(InvalidTokenError):
        decode_access_token(token, SECRET)
    # Logout uses this: an expired token still proves which session to revoke.
    assert decode_access_token(token, SECRET, verify_expiry=False).session_id == SESSION


def test_a_token_of_one_type_is_never_accepted_as_another() -> None:
    reset = encode_token("password_reset", USER, SECRET, timedelta(hours=1))

    with pytest.raises(InvalidTokenError):
        decode_token(reset, "verify_email", SECRET)
    with pytest.raises(InvalidTokenError):
        decode_access_token(reset, SECRET)


def test_the_wrong_key_is_refused() -> None:
    token = create_access_token(USER, "customer", SESSION, SECRET, timedelta(minutes=15))

    with pytest.raises(InvalidTokenError):
        decode_access_token(token, "some-other-secret-that-is-also-long-enough")


def test_the_none_algorithm_is_refused() -> None:
    """The classic JWT bypass: an unsigned token claiming alg=none."""

    def b64(data: dict[str, object]) -> str:
        return base64.urlsafe_b64encode(json.dumps(data).encode()).rstrip(b"=").decode()

    forged = (
        b64({"alg": "none", "typ": "JWT"})
        + "."
        + b64({"sub": str(USER), "typ": "access", "role": "owner", "sid": str(SESSION),
               "iss": "velo", "exp": 9_999_999_999})
        + "."
    )  # fmt: skip

    with pytest.raises(InvalidTokenError):
        decode_access_token(forged, SECRET)


def test_role_escalation_by_editing_the_payload_breaks_the_signature() -> None:
    token = create_access_token(USER, "customer", SESSION, SECRET, timedelta(minutes=15))
    payload = jwt.decode(token, options={"verify_signature": False})
    payload["role"] = "owner"
    header, _, signature = token.split(".")
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()

    with pytest.raises(InvalidTokenError):
        decode_access_token(f"{header}.{body}.{signature}", SECRET)


def test_opaque_tokens_are_unique_and_stored_only_as_a_hash() -> None:
    first, second = new_opaque_token(), new_opaque_token()

    assert first != second
    assert len(first) >= 43  # 256 bits, base64url
    assert hash_token(first) != first
    assert hash_token(first) == hash_token(first)


def test_fingerprint_changes_with_its_input() -> None:
    assert fingerprint("hash-a") != fingerprint("hash-b")
    assert fingerprint("hash-a") == fingerprint("hash-a")
