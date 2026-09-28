"""Fixed-window rate limiting on Redis (API-SPEC.md §1, "Rate limits").

A counter per (rule, subject) key that expires with its window. Fixed windows
allow a burst of up to twice the limit across a window boundary; for the
limits here — five logins per fifteen minutes — that is an acceptable trade
for one round trip and no Lua.

Redis unavailable means the limiter **fails open** and logs: an outage of the
cache must not become an outage of sign-in (DISCOVERY.md §7.2). Account lockout
lives in Postgres and keeps working regardless.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from redis.asyncio import Redis
from redis.exceptions import RedisError

from velo.core.logging import get_logger

logger = get_logger(__name__)

KEY_PREFIX = "velo:rl"


@dataclass(frozen=True, slots=True)
class Rule:
    name: str
    limit: int
    window_seconds: int


# API-SPEC.md §1. Keyed by what each rule names: IP, email, or user.
LOGIN_PER_IP = Rule("login-ip", 5, 15 * 60)
LOGIN_PER_EMAIL = Rule("login-email", 5, 15 * 60)
REGISTER_PER_IP = Rule("register-ip", 3, 60 * 60)
PASSWORD_RESET_PER_EMAIL = Rule("reset-email", 3, 60 * 60)
PASSWORD_RESET_PER_IP = Rule("reset-ip", 10, 60 * 60)
VERIFICATION_PER_EMAIL = Rule("verify-email", 3, 60 * 60)
TOKEN_REDEEM_PER_IP = Rule("token-ip", 20, 60 * 60)  # verify / reset submissions
REFRESH_PER_IP = Rule("refresh-ip", 60, 60)
SEARCH_PER_IP = Rule("search-ip", 60, 60)  # API-SPEC.md §1: search, 60 / min / IP
CART_MUTATIONS = Rule("cart", 60, 60)  # API-SPEC.md §1: 60 / min / cart
# Guessing discount codes: generous for a person, useless for a script.
DISCOUNT_CODE_PER_IP = Rule("discount-code-ip", 20, 60 * 60)


@dataclass(frozen=True, slots=True)
class RateLimitStatus:
    allowed: bool
    limit: int
    remaining: int
    reset_seconds: int

    def headers(self) -> dict[str, str]:
        headers = {
            "X-RateLimit-Limit": str(self.limit),
            "X-RateLimit-Remaining": str(self.remaining),
            "X-RateLimit-Reset": str(self.reset_seconds),
        }
        if not self.allowed:
            headers["Retry-After"] = str(self.reset_seconds)
        return headers


def _key(rule: Rule, subject: str) -> str:
    # Hashed: keys never hold an email address in plain text.
    digest = hashlib.sha256(subject.strip().lower().encode()).hexdigest()[:32]
    return f"{KEY_PREFIX}:{rule.name}:{digest}"


class RateLimiter:
    def __init__(self, redis: Redis) -> None:
        self._redis = redis

    async def peek(self, rule: Rule, subject: str) -> RateLimitStatus:
        """The current state, without counting a hit."""
        key = _key(rule, subject)
        try:
            async with self._redis.pipeline(transaction=False) as pipe:
                pipe.get(key)
                pipe.ttl(key)
                raw_count, ttl = await pipe.execute()
        except RedisError:
            logger.warning("rate_limit_unavailable", rule=rule.name)
            return RateLimitStatus(True, rule.limit, rule.limit, rule.window_seconds)
        count = int(raw_count or 0)
        return self._status(rule, count, ttl)

    async def hit(self, rule: Rule, subject: str) -> RateLimitStatus:
        """Count one hit and report whether it was within the limit."""
        key = _key(rule, subject)
        try:
            async with self._redis.pipeline(transaction=True) as pipe:
                pipe.incr(key)
                # NX: the window starts at the first hit and is not extended by later ones.
                pipe.expire(key, rule.window_seconds, nx=True)
                pipe.ttl(key)
                count, _, ttl = await pipe.execute()
        except RedisError:
            logger.warning("rate_limit_unavailable", rule=rule.name)
            return RateLimitStatus(True, rule.limit, rule.limit, rule.window_seconds)
        return self._status(rule, int(count) - 1, ttl, counted=True)

    async def reset(self, rule: Rule, subject: str) -> None:
        try:
            await self._redis.delete(_key(rule, subject))
        except RedisError:
            logger.warning("rate_limit_unavailable", rule=rule.name)

    @staticmethod
    def _status(rule: Rule, prior: int, ttl: int, *, counted: bool = False) -> RateLimitStatus:
        """``prior`` hits already in the window; ``counted`` if this call added one."""
        used = prior + (1 if counted else 0)
        allowed = prior < rule.limit
        reset = ttl if ttl and ttl > 0 else rule.window_seconds
        return RateLimitStatus(
            allowed=allowed,
            limit=rule.limit,
            remaining=max(rule.limit - used, 0),
            reset_seconds=reset,
        )
