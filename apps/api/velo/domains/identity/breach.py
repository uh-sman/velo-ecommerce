"""Breached-password check against Have I Been Pwned, by k-anonymity.

Only the first five hex characters of the password's SHA-1 leave the server;
the API returns every suffix sharing that prefix and the match happens here.
``Add-Padding`` makes every response a similar size, so an observer of the
encrypted traffic cannot infer the prefix from the response length.

If the service is unreachable the check **fails open**: a third-party outage
must not stop people registering. The length policy still applies.
"""

from __future__ import annotations

import hashlib
from typing import Protocol

import httpx

from velo.core.logging import get_logger

logger = get_logger(__name__)

RANGE_URL = "https://api.pwnedpasswords.com/range/"


class BreachChecker(Protocol):
    async def is_breached(self, password: str) -> bool: ...


class PwnedPasswordsChecker:
    def __init__(self, client: httpx.AsyncClient | None = None, timeout: float = 3.0) -> None:
        self._client = client
        self._timeout = timeout

    async def is_breached(self, password: str) -> bool:
        digest = hashlib.sha1(password.encode(), usedforsecurity=False).hexdigest().upper()
        prefix, suffix = digest[:5], digest[5:]
        try:
            if self._client is not None:
                response = await self._client.get(
                    RANGE_URL + prefix, headers={"Add-Padding": "true"}
                )
            else:
                async with httpx.AsyncClient(timeout=self._timeout) as client:
                    response = await client.get(RANGE_URL + prefix, headers={"Add-Padding": "true"})
            response.raise_for_status()
        except httpx.HTTPError:
            logger.warning("breach_check_unavailable")
            return False

        for line in response.text.splitlines():
            candidate, _, count = line.partition(":")
            # Padding entries have a count of 0 and are not real breaches.
            if candidate.strip() == suffix and count.strip() not in ("", "0"):
                return True
        return False


class NoBreachChecker:
    """Accepts everything. Used when the check is disabled, and in tests."""

    async def is_breached(self, password: str) -> bool:
        return False
