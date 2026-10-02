"""CSRF protection — the double-submit cookie (API-SPEC.md §1, ADR-008).

Authentication rides in cookies, which a browser attaches to any request to
this API, including one forged by another site. So every state-changing
request must also carry ``X-CSRF-Token`` equal to the ``velo_csrf`` cookie.
Another origin can make the browser *send* the cookie but cannot *read* it, so
it cannot produce the matching header.

Enforced in middleware, not per route: a route cannot forget it.

Exempt: safe methods, requests authenticated by an ``Authorization: Bearer``
header (no ambient credential to abuse), and provider webhooks, which are
authenticated by their signature instead.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp

from velo.api.cookies import CSRF_COOKIE, CSRF_HEADER, set_csrf_cookie
from velo.core.config import Settings
from velo.core.errors import ERROR_TYPE_BASE, PROBLEM_CONTENT_TYPE, ProblemDetail
from velo.core.logging import get_logger, get_request_id
from velo.core.security import constant_time_equals

logger = get_logger(__name__)

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "TRACE"})


class CsrfMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp, settings: Settings) -> None:
        super().__init__(app)
        self._settings = settings
        self._api_prefix = settings.api_prefix
        # Signed-token endpoints: the token in the link is the credential, and a
        # mail client's one-click unsubscribe cannot carry a CSRF header.
        self._exempt_prefixes = (
            f"{settings.api_prefix}/webhooks/",
            f"{settings.api_prefix}/email/",
        )

    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        path = request.url.path
        if not path.startswith(self._api_prefix):
            return await call_next(request)

        if request.method not in SAFE_METHODS and not self._exempt(request):
            cookie = request.cookies.get(CSRF_COOKIE, "")
            header = request.headers.get(CSRF_HEADER, "")
            if not cookie or not header or not constant_time_equals(cookie, header):
                logger.info("csrf_rejected", path=path, has_cookie=bool(cookie))
                return self._reject(path)

        response = await call_next(request)

        # Hand out a token on first contact, so an anonymous form (sign-in,
        # register) has one to echo before it has ever been signed in.
        if CSRF_COOKIE not in request.cookies and not _sets_cookie(response, CSRF_COOKIE):
            set_csrf_cookie(response, self._settings)
        return response

    def _exempt(self, request: Request) -> bool:
        if request.headers.get("Authorization", "").startswith("Bearer "):
            return True
        return request.url.path.startswith(self._exempt_prefixes)

    @staticmethod
    def _reject(path: str) -> Response:
        problem = ProblemDetail(
            type=f"{ERROR_TYPE_BASE}/csrf-failed",
            title="Missing or invalid CSRF token",
            status=403,
            detail=f"Send the {CSRF_COOKIE} cookie's value in the {CSRF_HEADER} header.",
            instance=path,
            request_id=get_request_id(),
        )
        return JSONResponse(
            status_code=403,
            content=problem.model_dump(exclude_none=True),
            media_type=PROBLEM_CONTENT_TYPE,
        )


def _sets_cookie(response: Response, name: str) -> bool:
    prefix = f"{name}=".encode()
    return any(
        key == b"set-cookie" and value.startswith(prefix) for key, value in response.raw_headers
    )
