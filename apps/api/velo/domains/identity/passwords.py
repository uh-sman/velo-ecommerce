"""Password hashing — Argon2id at the OWASP-recommended floor.

OWASP Password Storage Cheat Sheet: Argon2id, 19 MiB of memory, two
iterations, one degree of parallelism. The parameters are encoded in each hash,
so raising them later re-hashes users as they next log in (``needs_rehash``)
rather than invalidating anyone.
"""

from __future__ import annotations

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

_hasher = PasswordHasher(
    time_cost=2,
    memory_cost=19 * 1024,  # KiB
    parallelism=1,
    hash_len=32,
    salt_len=16,
)


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    """Constant-time check. A malformed hash is a failed login, never a 500."""
    try:
        return _hasher.verify(password_hash, password)
    except (VerificationError, InvalidHashError):
        return False


def needs_rehash(password_hash: str) -> bool:
    return _hasher.check_needs_rehash(password_hash)
