"""Argon2id password hashing."""

from __future__ import annotations

from velo.domains.identity.passwords import hash_password, needs_rehash, verify_password


def test_hash_is_argon2id_at_owasp_parameters() -> None:
    password_hash = hash_password("correct horse battery staple")

    assert password_hash.startswith("$argon2id$")
    assert "m=19456,t=2,p=1" in password_hash
    assert not needs_rehash(password_hash)


def test_verification() -> None:
    password_hash = hash_password("correct horse battery staple")

    assert verify_password(password_hash, "correct horse battery staple")
    assert not verify_password(password_hash, "Correct horse battery staple")


def test_hashes_are_salted() -> None:
    assert hash_password("same") != hash_password("same")


def test_a_malformed_hash_is_a_failed_check_not_an_exception() -> None:
    assert not verify_password("not-a-hash", "anything")
