"""The session cookies of API-SPEC.md §1 — names, scopes, and flags in one place.

| Cookie         | Flags                                   | Path                   |
| -------------- | --------------------------------------- | ---------------------- |
| `velo_access`  | HttpOnly; Secure; SameSite=Lax          | `/`                    |
| `velo_refresh` | HttpOnly; Secure; SameSite=Lax          | `/api/v1/auth/refresh` |
| `velo_csrf`    | Secure; SameSite=Lax — readable by JS   | `/`                    |
| `velo_cart`    | HttpOnly; Secure; SameSite=Lax          | `/`                    |
| `velo_checkout`| HttpOnly; Secure; SameSite=Lax          | `/api/v1`              |

The refresh cookie's narrow path means the browser sends it to one endpoint
and nowhere else, so it never rides along on an ordinary request.
"""

from __future__ import annotations

from starlette.responses import Response

from velo.core.config import Settings
from velo.core.security import new_opaque_token
from velo.domains.identity.service import IssuedSession

ACCESS_COOKIE = "velo_access"
REFRESH_COOKIE = "velo_refresh"
CSRF_COOKIE = "velo_csrf"
CSRF_HEADER = "X-CSRF-Token"
CART_COOKIE = "velo_cart"  # the guest cart's opaque token; HttpOnly
CART_COOKIE_MAX_AGE = 30 * 24 * 3600
# Proves a browser owns a checkout session (API-SPEC.md §2, "Checkout"); HttpOnly.
CHECKOUT_COOKIE = "velo_checkout"
CHECKOUT_COOKIE_MAX_AGE = 24 * 3600


def _domain(settings: Settings) -> str | None:
    # Browsers reject an explicit Domain=localhost; a host-only cookie is what
    # local development needs, and it is shared across ports.
    domain = settings.cookie_domain.strip()
    return None if domain in ("", "localhost") else domain


def refresh_path(settings: Settings) -> str:
    return f"{settings.api_prefix}/auth/refresh"


def set_session_cookies(response: Response, issued: IssuedSession, settings: Settings) -> None:
    domain = _domain(settings)
    response.set_cookie(
        ACCESS_COOKIE,
        issued.access_token,
        max_age=int(issued.access_ttl.total_seconds()),
        path="/",
        domain=domain,
        secure=settings.cookie_secure,
        httponly=True,
        samesite="lax",
    )
    response.set_cookie(
        REFRESH_COOKIE,
        issued.refresh_token,
        max_age=int(issued.refresh_ttl.total_seconds()),
        path=refresh_path(settings),
        domain=domain,
        secure=settings.cookie_secure,
        httponly=True,
        samesite="lax",
    )
    # A fresh CSRF token at every sign-in: a token planted before sign-in
    # (login CSRF, token fixation) does not survive into the session.
    set_csrf_cookie(response, settings)


def clear_session_cookies(response: Response, settings: Settings) -> None:
    domain = _domain(settings)
    response.delete_cookie(ACCESS_COOKIE, path="/", domain=domain)
    response.delete_cookie(REFRESH_COOKIE, path=refresh_path(settings), domain=domain)


def set_csrf_cookie(response: Response, settings: Settings, token: str | None = None) -> str:
    token = token or new_opaque_token()
    response.set_cookie(
        CSRF_COOKIE,
        token,
        path="/",
        domain=_domain(settings),
        secure=settings.cookie_secure,
        httponly=False,  # by design: the frontend reads it to echo it in the header
        samesite="lax",
    )
    return token


def set_cart_cookie(response: Response, token: str, settings: Settings) -> None:
    response.set_cookie(
        CART_COOKIE,
        token,
        max_age=CART_COOKIE_MAX_AGE,
        path="/",
        domain=_domain(settings),
        secure=settings.cookie_secure,
        httponly=True,
        samesite="lax",
    )


def clear_cart_cookie(response: Response, settings: Settings) -> None:
    response.delete_cookie(CART_COOKIE, path="/", domain=_domain(settings))


def set_checkout_cookie(response: Response, token: str, settings: Settings) -> None:
    response.set_cookie(
        CHECKOUT_COOKIE,
        token,
        max_age=CHECKOUT_COOKIE_MAX_AGE,
        path=settings.api_prefix,  # only the API needs it
        domain=_domain(settings),
        secure=settings.cookie_secure,
        httponly=True,
        samesite="lax",
    )
