"""Identity service — registration, sign-in, sessions, and recovery.

No HTTP here (ARCHITECTURE.md §3, rule 2): cookies are the router's concern.
This module decides who someone is and what they may hold; it returns tokens
and raises domain errors.

The service owns the transaction: each public method commits exactly once on
success, and failed sign-ins commit their attempt counter before raising.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from typing import Any

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from velo.core import rate_limit
from velo.core.config import Settings
from velo.core.email import EmailMessage, Mailer
from velo.core.errors import FieldError, NotFoundError, RateLimitedError, ValidationError
from velo.core.logging import get_logger
from velo.core.rate_limit import RateLimiter, RateLimitStatus, Rule
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
from velo.domains.identity.breach import BreachChecker
from velo.domains.identity.exceptions import (
    AccountSuspendedError,
    EmailTakenError,
    InvalidCredentialsError,
    InvalidLinkError,
    RefreshSupersededError,
    SessionExpiredError,
    TooManyAttemptsError,
    WrongPasswordError,
)
from velo.domains.identity.passwords import hash_password, needs_rehash, verify_password
from velo.domains.identity.permissions import is_staff
from velo.domains.identity.repository import (
    RefreshTokenRepository,
    SessionRecord,
    UserRecord,
    UserRepository,
)
from velo.domains.platform.events import record_event
from velo.domains.platform.settings import SettingsService
from velo.emails.render import render

logger = get_logger(__name__)

PASSWORD_MIN_LENGTH = 10
PASSWORD_MAX_LENGTH = 128  # Argon2 has no length limit, but a 1 MB "password" is a DoS

LOCKOUT_THRESHOLD = 5
LOCKOUT_BASE = timedelta(minutes=15)
LOCKOUT_MAX = timedelta(hours=24)

STAFF_REFRESH_TTL = timedelta(days=7)  # ADR-008
# Two tabs refreshing with the same token inside this window is a race, not theft.
REFRESH_REUSE_GRACE = timedelta(seconds=10)

VERIFY_EMAIL_TTL = timedelta(hours=24)
PASSWORD_RESET_TTL = timedelta(hours=1)


@lru_cache(maxsize=1)
def _dummy_hash() -> str:
    """Verified against when the email is unknown, so both paths cost one Argon2 run."""
    return hash_password(new_opaque_token())


@dataclass(frozen=True, slots=True)
class ClientInfo:
    ip: str
    user_agent: str | None


@dataclass(frozen=True, slots=True)
class IssuedSession:
    user: UserRecord
    session_id: uuid.UUID
    access_token: str
    access_ttl: timedelta
    refresh_token: str
    refresh_ttl: timedelta


@dataclass(frozen=True, slots=True)
class ActiveSession:
    id: uuid.UUID
    signed_in_at: datetime
    last_active_at: datetime
    user_agent: str | None
    ip_address: str | None
    is_current: bool


def _now() -> datetime:
    return datetime.now(UTC)


def verification_url(settings: Settings, user_id: uuid.UUID, email: str) -> str:
    """A fresh verify-email link: signed, expiring, and bound to ``email`` —
    if the address changes, the link stops working."""
    token = encode_token(
        "verify_email",
        user_id,
        settings.secret_key.get_secret_value(),
        VERIFY_EMAIL_TTL,
        fp=fingerprint(email),
    )
    return f"{settings.storefront_url}/verify-email?token={token}"


def password_problems(password: str, email: str | None = None) -> list[FieldError]:
    """Length and similarity rules (NIST SP 800-63B): no composition rules,
    which push people towards ``Password1!`` rather than towards strength."""
    problems: list[FieldError] = []
    if len(password) < PASSWORD_MIN_LENGTH:
        problems.append(
            FieldError(
                field="password",
                code="too_short",
                message=f"Use at least {PASSWORD_MIN_LENGTH} characters.",
            )
        )
    if len(password) > PASSWORD_MAX_LENGTH:
        problems.append(
            FieldError(
                field="password",
                code="too_long",
                message=f"Use at most {PASSWORD_MAX_LENGTH} characters.",
            )
        )
    if email and password.strip().lower() in {email.lower(), email.split("@")[0].lower()}:
        problems.append(
            FieldError(
                field="password",
                code="matches_email",
                message="Your password cannot be your email address.",
            )
        )
    return problems


class AuthService:
    def __init__(
        self,
        session: AsyncSession,
        settings: Settings,
        limiter: RateLimiter,
        mailer: Mailer,
        breach_checker: BreachChecker,
    ) -> None:
        self._session = session
        self._settings = settings
        self._users = UserRepository(session)
        self._tokens = RefreshTokenRepository(session)
        self._limiter = limiter
        self._mailer = mailer
        self._breach = breach_checker

    @property
    def _secret(self) -> str:
        return self._settings.secret_key.get_secret_value()

    # ── Registration ──────────────────────────────────────────────────────

    async def register(
        self,
        *,
        email: str,
        password: str,
        first_name: str | None,
        last_name: str | None,
        marketing_opt_in: bool,
        client: ClientInfo,
    ) -> IssuedSession:
        # Cheap rules first, so a typo does not spend one of three hourly
        # attempts; the rate limit then guards the third-party breach lookup.
        if problems := password_problems(password, email):
            raise ValidationError("Choose a different password.", errors=problems)
        await self._enforce(rate_limit.REGISTER_PER_IP, client.ip)
        await self._check_new_password(password, email)

        if await self._users.get_by_email(email) is not None:
            raise EmailTakenError(
                "Sign in instead, or reset your password if you have forgotten it.",
                errors=[FieldError(field="email", code="taken", message="Already registered.")],
            )
        try:
            user = await self._users.create(
                email=email,
                password_hash=hash_password(password),
                first_name=first_name,
                last_name=last_name,
                marketing_opt_in=marketing_opt_in,
            )
        except IntegrityError as exc:  # a concurrent registration won the race
            await self._session.rollback()
            raise EmailTakenError() from exc

        issued = await self._start_session(user, client)
        # The welcome and verification emails go through the outbox: committed
        # with the account, sent by the worker, retried until delivered.
        record_event(
            self._session,
            "user",
            user.id,
            "user.registered",
            {"email": user.email, "first_name": first_name},
        )
        self._request_verification(user)
        await self._session.commit()
        logger.info("user_registered", user_id=str(user.id))
        return issued

    # ── Sign-in ───────────────────────────────────────────────────────────

    async def login(self, *, email: str, password: str, client: ClientInfo) -> IssuedSession:
        for rule, subject in (
            (rate_limit.LOGIN_PER_IP, client.ip),
            (rate_limit.LOGIN_PER_EMAIL, email),
        ):
            status = await self._limiter.peek(rule, subject)
            if not status.allowed:
                raise TooManyAttemptsError(
                    "Too many attempts. Try again later, or reset your password.",
                    headers=status.headers(),
                )

        found = await self._users.get_by_email(email)
        if found is None or found.password_hash is None:
            verify_password(_dummy_hash(), password)  # equal work: no timing oracle
            await self._record_failure(email, client)
            raise InvalidCredentialsError()

        user = await self._users.lock_for_update(found.id)
        assert user is not None and user.password_hash is not None
        now = _now()

        if user.locked_until is not None and user.locked_until > now:
            await self._session.rollback()
            retry = int((user.locked_until - now).total_seconds()) + 1
            raise TooManyAttemptsError(
                "Too many attempts. Try again later, or reset your password.",
                headers={"Retry-After": str(retry)},
            )

        if not verify_password(user.password_hash, password):
            await self._record_failure(email, client, user=user)
            raise InvalidCredentialsError()

        if user.status != "active":
            await self._session.rollback()
            raise AccountSuspendedError("Contact support if you think this is a mistake.")

        updates: dict[str, Any] = {"failed_login_count": 0, "locked_until": None}
        if needs_rehash(user.password_hash):
            updates["password_hash"] = hash_password(password)
        user = await self._users.update(user.id, **updates)

        issued = await self._start_session(user, client)
        await self._session.commit()
        await self._limiter.reset(rate_limit.LOGIN_PER_EMAIL, email)
        logger.info("user_logged_in", user_id=str(user.id))
        return issued

    async def _record_failure(
        self, email: str, client: ClientInfo, *, user: UserRecord | None = None
    ) -> None:
        await self._limiter.hit(rate_limit.LOGIN_PER_IP, client.ip)
        await self._limiter.hit(rate_limit.LOGIN_PER_EMAIL, email)
        if user is None:
            await self._session.rollback()
            return

        count = await self._users.increment_failed_logins(user.id)
        locked = count % LOCKOUT_THRESHOLD == 0
        if locked:
            # Exponential backoff: 15 min, 30, 60, … capped at a day.
            strikes = count // LOCKOUT_THRESHOLD
            duration = min(LOCKOUT_BASE * 2 ** (strikes - 1), LOCKOUT_MAX)
            await self._users.update(user.id, locked_until=_now() + duration)
        await self._session.commit()

        if locked:
            logger.warning("account_locked", user_id=str(user.id), failed_attempts=count)
            await self._mailer.send(
                EmailMessage(
                    to=user.email,
                    subject="Your Velo account was temporarily locked",
                    text=(
                        "There were several unsuccessful attempts to sign in to your Velo "
                        "account, so we have paused sign-in for a while.\n\n"
                        "If this was you, wait a little and try again, or reset your "
                        f"password:\n{self._settings.storefront_url}/forgot-password\n\n"
                        "If it was not you, your password is still safe — but consider "
                        "changing it to something you do not use anywhere else."
                    ),
                )
            )

    # ── Sessions ──────────────────────────────────────────────────────────

    def _refresh_ttl(self, role: str) -> timedelta:
        default = timedelta(seconds=self._settings.refresh_token_ttl_seconds)
        return min(default, STAFF_REFRESH_TTL) if is_staff(role) else default

    async def _issue(
        self, user: UserRecord, family_id: uuid.UUID, client: ClientInfo
    ) -> IssuedSession:
        refresh_token = new_opaque_token()
        refresh_ttl = self._refresh_ttl(user.role)
        await self._tokens.create(
            user_id=user.id,
            token_hash=hash_token(refresh_token),
            family_id=family_id,
            expires_at=_now() + refresh_ttl,
            user_agent=(client.user_agent or "")[:512] or None,
            ip_address=client.ip or None,
        )
        access_ttl = timedelta(seconds=self._settings.access_token_ttl_seconds)
        return IssuedSession(
            user=user,
            session_id=family_id,
            access_token=create_access_token(
                user.id, user.role, family_id, self._secret, access_ttl
            ),
            access_ttl=access_ttl,
            refresh_token=refresh_token,
            refresh_ttl=refresh_ttl,
        )

    async def _start_session(self, user: UserRecord, client: ClientInfo) -> IssuedSession:
        return await self._issue(user, uuid.uuid4(), client)

    async def refresh(self, refresh_token: str | None, client: ClientInfo) -> IssuedSession:
        """Rotate: the presented token is spent and a new one issued in the same family.

        A spent token presented again is either a race between two tabs (inside
        the grace window) or a stolen token being replayed. In the second case
        the whole family is revoked: whichever party holds the live token —
        thief or owner — is signed out, and the owner signs back in.
        """
        await self._enforce(rate_limit.REFRESH_PER_IP, client.ip)
        if not refresh_token:
            raise SessionExpiredError()

        token = await self._tokens.get_by_hash_for_update(hash_token(refresh_token))
        now = _now()
        if token is None or token.revoked_at is not None or token.expires_at <= now:
            await self._session.rollback()
            raise SessionExpiredError()

        if token.used_at is not None:
            if now - token.used_at <= REFRESH_REUSE_GRACE:
                await self._session.rollback()
                raise RefreshSupersededError()
            await self._tokens.revoke_family(token.family_id, now)
            await self._session.commit()
            logger.warning(
                "refresh_token_reuse",
                user_id=str(token.user_id),
                session_id=str(token.family_id),
            )
            raise SessionExpiredError()

        user = await self._users.get_by_id(token.user_id)
        if user is None or user.status != "active":
            await self._tokens.revoke_family(token.family_id, now)
            await self._session.commit()
            raise SessionExpiredError()

        await self._tokens.mark_used(token.id, now)
        issued = await self._issue(user, token.family_id, client)
        await self._session.commit()
        return issued

    async def logout(self, access_token: str | None) -> None:
        """Revoke the session server-side. Idempotent.

        The access token identifies the session even if it has just expired:
        its signature still proves which session it was issued under, and all
        that is done with it is revoke.
        """
        if not access_token:
            return
        try:
            claims = decode_access_token(access_token, self._secret, verify_expiry=False)
        except InvalidTokenError:
            return
        await self._tokens.revoke_family(claims.session_id, _now())
        await self._session.commit()

    async def list_sessions(
        self, user_id: uuid.UUID, current_session_id: uuid.UUID
    ) -> list[ActiveSession]:
        records: list[SessionRecord] = await self._tokens.list_active_sessions(user_id, _now())
        return [
            ActiveSession(
                id=record.family_id,
                signed_in_at=record.signed_in_at,
                last_active_at=record.last_active_at,
                user_agent=record.user_agent,
                ip_address=record.ip_address,
                is_current=record.family_id == current_session_id,
            )
            for record in records
        ]

    async def revoke_session(self, user_id: uuid.UUID, session_id: uuid.UUID) -> None:
        if await self._tokens.family_owner(session_id) != user_id:
            raise NotFoundError("No such session.")  # someone else's is simply not found
        await self._tokens.revoke_family(session_id, _now())
        await self._session.commit()

    # ── Profile ───────────────────────────────────────────────────────────

    async def get_user(self, user_id: uuid.UUID) -> UserRecord:
        user = await self._users.get_by_id(user_id)
        if user is None or user.status != "active":
            raise SessionExpiredError()
        return user

    async def update_profile(self, user_id: uuid.UUID, **changes: Any) -> UserRecord:
        await self.get_user(user_id)
        user = await self._users.update(user_id, **changes) if changes else None
        await self._session.commit()
        return user or await self.get_user(user_id)

    async def change_password(
        self,
        user_id: uuid.UUID,
        current_session_id: uuid.UUID,
        *,
        current_password: str,
        new_password: str,
    ) -> None:
        user = await self.get_user(user_id)
        if user.password_hash is None or not verify_password(user.password_hash, current_password):
            raise WrongPasswordError(
                errors=[
                    FieldError(
                        field="current_password", code="incorrect", message="Incorrect password."
                    )
                ]
            )
        await self._check_new_password(new_password, user.email)
        await self._users.update(user_id, password_hash=hash_password(new_password))
        # Every other device is signed out; this one stays signed in.
        await self._tokens.revoke_all_for_user(user_id, _now(), except_family=current_session_id)
        await self._session.commit()
        await self._mailer.send(
            EmailMessage(
                to=user.email,
                subject="Your Velo password was changed",
                text=(
                    "The password for your Velo account was just changed, and every other "
                    "device was signed out.\n\nIf this was not you, reset your password now:\n"
                    f"{self._settings.storefront_url}/forgot-password"
                ),
            )
        )

    # ── Email verification ────────────────────────────────────────────────

    def _request_verification(self, user: UserRecord) -> None:
        """Queue the verification email. The worker mints the link when it sends
        (:func:`verification_url`), so no token is ever stored in the outbox."""
        record_event(
            self._session, "user", user.id, "user.verification_requested", {"email": user.email}
        )

    async def _templated(self, kind: str, to: str, context: dict[str, Any]) -> None:
        """An account email from its template (ADR-011), sent inline: the link is in it."""
        values = await SettingsService(self._session, self._settings).all()
        rendered = render(kind, context, store=values["store"], texts=values["emails"])
        await self._mailer.send(
            EmailMessage(to=to, subject=rendered.subject, text=rendered.text, html=rendered.html)
        )

    async def verify_email(self, token: str, client: ClientInfo) -> UserRecord:
        await self._enforce(rate_limit.TOKEN_REDEEM_PER_IP, client.ip)
        try:
            payload = decode_token(token, "verify_email", self._secret)
            user_id = uuid.UUID(payload["sub"])
        except (InvalidTokenError, KeyError, ValueError) as exc:
            raise InvalidLinkError("Request a new verification email.") from exc

        user = await self._users.get_by_id(user_id)
        # The fingerprint binds the token to the address it was sent to: if the
        # email has since changed, the old link cannot verify the new address.
        if user is None or payload.get("fp") != fingerprint(user.email):
            raise InvalidLinkError("Request a new verification email.")
        if user.email_verified_at is None:
            user = await self._users.update(user_id, email_verified_at=_now())
            await self._session.commit()
        return user  # verifying twice is harmless, and reports success

    async def resend_verification(self, email: str, client: ClientInfo) -> None:
        """Always succeeds from the caller's point of view — no enumeration."""
        await self._enforce(rate_limit.VERIFICATION_PER_EMAIL, email)
        user = await self._users.get_by_email(email)
        if user is not None and user.email_verified_at is None and user.status == "active":
            self._request_verification(user)
            await self._session.commit()

    # ── Password reset ────────────────────────────────────────────────────

    async def forgot_password(self, email: str, client: ClientInfo) -> None:
        """Always 204, whether or not the account exists (API-SPEC.md §2)."""
        await self._enforce(rate_limit.PASSWORD_RESET_PER_IP, client.ip)
        await self._enforce(rate_limit.PASSWORD_RESET_PER_EMAIL, email)
        user = await self._users.get_by_email(email)
        if user is None or user.status != "active":
            return
        token = encode_token(
            "password_reset",
            user.id,
            self._secret,
            PASSWORD_RESET_TTL,
            fp=fingerprint(user.password_hash or ""),
        )
        await self._templated(
            "password_reset",
            user.email,
            {"reset_url": f"{self._settings.storefront_url}/reset-password?token={token}"},
        )

    async def reset_password(self, token: str, new_password: str, client: ClientInfo) -> None:
        await self._enforce(rate_limit.TOKEN_REDEEM_PER_IP, client.ip)
        try:
            payload = decode_token(token, "password_reset", self._secret)
            user_id = uuid.UUID(payload["sub"])
        except (InvalidTokenError, KeyError, ValueError) as exc:
            raise InvalidLinkError("Request a new password-reset email.") from exc

        user = await self._users.lock_for_update(user_id)
        # Single use: the fingerprint is of the password hash the link was
        # issued against. Once the password changes, the link is dead.
        if (
            user is None
            or user.status != "active"
            or payload.get("fp") != fingerprint(user.password_hash or "")
        ):
            await self._session.rollback()
            raise InvalidLinkError("Request a new password-reset email.")

        await self._check_new_password(new_password, user.email)
        now = _now()
        await self._users.update(
            user_id,
            password_hash=hash_password(new_password),
            failed_login_count=0,
            locked_until=None,
            # Receiving the link proves control of the inbox.
            email_verified_at=user.email_verified_at or now,
        )
        await self._tokens.revoke_all_for_user(user_id, now)
        await self._session.commit()
        await self._limiter.reset(rate_limit.LOGIN_PER_EMAIL, user.email)
        logger.info("password_reset", user_id=str(user_id))

    # ── Helpers ───────────────────────────────────────────────────────────

    async def _check_new_password(self, password: str, email: str) -> None:
        problems = password_problems(password, email)
        if not problems and await self._breach.is_breached(password):
            problems.append(
                FieldError(
                    field="password",
                    code="breached",
                    message=(
                        "This password has appeared in a data breach. Choose one you have "
                        "not used anywhere else."
                    ),
                )
            )
        if problems:
            raise ValidationError("Choose a different password.", errors=problems)

    async def _enforce(self, rule: Rule, subject: str) -> RateLimitStatus:
        status = await self._limiter.hit(rule, subject)
        if not status.allowed:
            raise RateLimitedError(
                f"Too many requests. Try again in {status.reset_seconds} seconds.",
                headers=status.headers(),
            )
        return status
