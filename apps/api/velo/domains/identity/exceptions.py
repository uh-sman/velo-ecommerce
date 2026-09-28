"""Identity errors. Services raise these; the global handler renders them."""

from __future__ import annotations

from http import HTTPStatus

from velo.core.errors import ConflictError, DomainError, RateLimitedError


class InvalidCredentialsError(DomainError):
    """The same response for an unknown email and a wrong password (PAGE-SPECS.md §2.1)."""

    status_code = HTTPStatus.UNAUTHORIZED
    slug = "invalid-credentials"
    title = "Email or password is incorrect"


class TooManyAttemptsError(RateLimitedError):
    """Rate limit or account lockout — one response for both.

    Distinct responses would tell an attacker which emails have accounts: only
    a real account can be locked.
    """

    slug = "too-many-attempts"
    title = "Too many sign-in attempts"


class AccountSuspendedError(DomainError):
    status_code = HTTPStatus.FORBIDDEN
    slug = "account-suspended"
    title = "This account is suspended"


class EmailTakenError(ConflictError):
    slug = "email-taken"
    title = "An account with this email already exists"


class InvalidLinkError(DomainError):
    """A verification or reset link that is expired, already used, or forged."""

    status_code = HTTPStatus.BAD_REQUEST
    slug = "invalid-or-expired-link"
    title = "This link is invalid or has expired"


class SessionExpiredError(DomainError):
    """The refresh token is missing, expired, revoked, or was reused."""

    status_code = HTTPStatus.UNAUTHORIZED
    slug = "session-expired"
    title = "Your session has expired"


class RefreshSupersededError(DomainError):
    """Two tabs refreshed at once and this one lost the race.

    Not an attack: the winning request has already set fresh cookies in this
    browser, so the client simply retries once.
    """

    status_code = HTTPStatus.CONFLICT
    slug = "refresh-superseded"
    title = "Session already refreshed"


class WrongPasswordError(DomainError):
    """Change-password with an incorrect current password."""

    status_code = HTTPStatus.UNPROCESSABLE_ENTITY
    slug = "wrong-password"
    title = "The current password is incorrect"


class DefaultAddressError(ConflictError):
    slug = "default-address"
    title = "Choose another default address first"


class AddressLimitError(ConflictError):
    slug = "address-limit"
    title = "Address book is full"
