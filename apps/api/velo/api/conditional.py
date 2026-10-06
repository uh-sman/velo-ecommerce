"""Conditional GET — ``ETag`` and ``304 Not Modified`` for public reads (PLANNING.md Phase 14).

The storefront re-reads the same catalog JSON constantly: every navigation,
every revalidation of a cached page. Most of the time nothing has changed, so
the API tags each body with a validator and answers a matching
``If-None-Match`` with an empty 304 — the query still runs, but the payload
(often tens of kilobytes) does not cross the wire again.

Scoped by path prefix, deliberately, rather than applied to every GET: an ETag
is only as safe as the response it describes, and the prefixes given here are
the anonymous catalog and search reads, whose bodies are the same for everyone.
Within them a response is still skipped when it

- is not a ``200`` JSON body (errors, redirects, CSV, images);
- sets a cookie in the route — whatever it carries is per client, never a
  shared validator. (The CSRF cookie is added further out, independent of the
  body, and never on a ``public`` response: see ``velo.api.csrf``);
- says ``no-store`` — it has asked not to be kept, so there is nothing to
  revalidate.

The ETag is a hash of the body, not of a row version: the catalog is cached
and composed from several tables, so the body is the one thing that changes
exactly when the response does. It is *weak* (``W/``) because the GZip
middleware outside this one may re-encode the bytes, and a strong validator
promises byte-identical representations.

``HEAD`` is answered here too, for the same paths: FastAPI routes ``GET`` only,
so the request is run as a ``GET`` and the body dropped, keeping the headers —
``Content-Length`` and ``ETag`` included — exactly as ``GET`` would send them.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable

from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

# Headers describing a body that a 304 does not have (RFC 9110 §15.4.5).
_BODY_HEADERS = ("content-length", "content-type", "content-encoding")


class ConditionalGetMiddleware:
    """Pure ASGI rather than ``BaseHTTPMiddleware``: it must see, and hold back,
    the start message until the body is known."""

    def __init__(self, app: ASGIApp, *, prefixes: Iterable[str]) -> None:
        self.app = app
        self._prefixes = tuple(prefix.rstrip("/") for prefix in prefixes)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] != "http"
            or scope["method"] not in ("GET", "HEAD")
            or not self._in_scope(scope["path"])
        ):
            await self.app(scope, receive, send)
            return

        head = scope["method"] == "HEAD"
        if head:
            scope = {**scope, "method": "GET"}
        if_none_match = Headers(scope=scope).get("if-none-match")

        start: Message | None = None
        eligible = False
        chunks: list[bytes] = []

        async def send_conditionally(message: Message) -> None:
            nonlocal start, eligible
            if message["type"] == "http.response.start":
                start = message
                eligible = _eligible(message)
                if not eligible:
                    await send(message)
                return
            if message["type"] != "http.response.body":
                await send(message)
                return
            if not eligible:
                await send({**message, "body": b""} if head else message)
                return

            # Catalog bodies are bounded JSON, so buffering a multi-part one is fine.
            chunks.append(message.get("body", b""))
            if message.get("more_body", False):
                return
            assert start is not None
            body = b"".join(chunks)
            etag = _etag(body)
            headers = MutableHeaders(raw=list(start["headers"]))
            headers["ETag"] = etag
            # The body may be gzipped further out; a 304 must carry the same Vary.
            headers.add_vary_header("Accept-Encoding")

            if if_none_match is not None and _matches(if_none_match, etag):
                for name in _BODY_HEADERS:
                    del headers[name]
                await send({**start, "status": 304, "headers": headers.raw})
                await send({"type": "http.response.body", "body": b""})
                return
            await send({**start, "headers": headers.raw})
            await send({"type": "http.response.body", "body": b"" if head else body})

        await self.app(scope, receive, send_conditionally)

    def _in_scope(self, path: str) -> bool:
        # By segment: "/products" covers "/products/x" but not "/productsx".
        return any(path == prefix or path.startswith(f"{prefix}/") for prefix in self._prefixes)


def _eligible(start: Message) -> bool:
    if start["status"] != 200:
        return False
    headers = Headers(raw=start["headers"])
    content_type = headers.get("content-type", "").partition(";")[0].strip().lower()
    if content_type != "application/json":
        return False
    if "set-cookie" in headers or "etag" in headers:
        return False
    directives = {d.strip().lower() for d in headers.get("cache-control", "").split(",")}
    return "no-store" not in directives


def _etag(body: bytes) -> str:
    # 128 bits is ample for telling versions of one URL apart; this is not a MAC.
    return f'W/"{hashlib.blake2b(body, digest_size=16).hexdigest()}"'


def _matches(if_none_match: str, etag: str) -> bool:
    """Weak comparison, as ``If-None-Match`` requires (RFC 9110 §13.1.2)."""
    if if_none_match.strip() == "*":
        return True
    opaque = etag.removeprefix("W/")
    return any(
        candidate.strip().removeprefix("W/") == opaque for candidate in if_none_match.split(",")
    )
