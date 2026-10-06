"""Compression and conditional GET (PLANNING.md Phase 14).

The middleware is exercised on a small app of its own, so each eligibility rule
has a route that breaks exactly that rule; the real app's wiring is checked on
routes that need no database.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
from fastapi import FastAPI, Response
from fastapi.responses import PlainTextResponse, StreamingResponse
from httpx import ASGITransport, AsyncClient
from starlette.middleware.gzip import GZipMiddleware

from velo.api.conditional import ConditionalGetMiddleware
from velo.core.errors import NotFoundError, register_exception_handlers

PUBLIC = "public, max-age=30"
CATALOG: dict[str, object] = {
    "items": [{"slug": f"tee-{n}", "title": "A plain tee"} for n in range(60)]
}


def _app() -> FastAPI:
    app = FastAPI()
    register_exception_handlers(app)

    @app.get("/api/v1/products")
    async def products(response: Response) -> dict[str, object]:
        response.headers["Cache-Control"] = PUBLIC
        return CATALOG

    @app.get("/api/v1/products/missing")
    async def missing() -> None:
        raise NotFoundError("No such product.")

    @app.get("/api/v1/products/cookie")
    async def cookie(response: Response) -> dict[str, str]:
        response.set_cookie("velo_csrf", "per-client")
        return {"ok": "yes"}

    @app.get("/api/v1/products/no-store")
    async def no_store(response: Response) -> dict[str, str]:
        response.headers["Cache-Control"] = "no-store"
        return {"ok": "yes"}

    @app.get("/api/v1/products/text")
    async def text() -> PlainTextResponse:
        return PlainTextResponse("plain")

    @app.get("/api/v1/products/stream")
    async def stream() -> StreamingResponse:
        async def chunks() -> AsyncIterator[bytes]:
            for n in range(3):
                yield f"row {n}\n".encode() * 200

        return StreamingResponse(chunks(), media_type="text/csv")

    @app.get("/api/v1/productsx")
    async def lookalike() -> dict[str, str]:
        return {"ok": "yes"}

    @app.get("/api/v1/account/me")
    async def account() -> dict[str, str]:
        return {"email": "casey@example.com"}

    app.add_middleware(ConditionalGetMiddleware, prefixes=["/api/v1/products"])
    app.add_middleware(GZipMiddleware, minimum_size=1000)
    return app


@pytest.fixture
async def http() -> AsyncIterator[AsyncClient]:
    transport = ASGITransport(app=_app())
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client


# ── ETag and 304 ──────────────────────────────────────────────────────────────


async def test_a_public_json_read_carries_a_weak_etag(http: AsyncClient) -> None:
    response = await http.get("/api/v1/products")

    assert response.status_code == 200
    assert response.headers["etag"].startswith('W/"')
    assert response.headers["cache-control"] == PUBLIC
    assert response.json() == CATALOG


async def test_the_etag_is_stable_for_an_unchanged_body(http: AsyncClient) -> None:
    first = await http.get("/api/v1/products")
    second = await http.get("/api/v1/products")

    assert first.headers["etag"] == second.headers["etag"]


@pytest.mark.parametrize(
    "header",
    [
        "{etag}",
        "{strong}",  # weak comparison: W/ is ignored
        '"something-else", {etag}',
        "*",
    ],
)
async def test_a_matching_if_none_match_gets_an_empty_304(http: AsyncClient, header: str) -> None:
    etag = (await http.get("/api/v1/products")).headers["etag"]
    header = header.format(etag=etag, strong=etag.removeprefix("W/"))

    response = await http.get("/api/v1/products", headers={"If-None-Match": header})

    assert response.status_code == 304
    assert response.content == b""
    assert response.headers["etag"] == etag
    # A 304 keeps the caching headers the 200 would have sent, but no body headers.
    assert response.headers["cache-control"] == PUBLIC
    assert "accept-encoding" in response.headers["vary"].lower()
    assert "content-type" not in response.headers


async def test_a_stale_if_none_match_gets_the_full_body(http: AsyncClient) -> None:
    response = await http.get("/api/v1/products", headers={"If-None-Match": 'W/"stale"'})

    assert response.status_code == 200
    assert response.json() == CATALOG


async def test_head_is_answered_with_get_headers_and_no_body(http: AsyncClient) -> None:
    get = await http.get("/api/v1/products", headers={"Accept-Encoding": "identity"})
    head = await http.head("/api/v1/products", headers={"Accept-Encoding": "identity"})

    assert head.status_code == 200
    assert head.content == b""
    assert head.headers["etag"] == get.headers["etag"]
    assert head.headers["content-length"] == get.headers["content-length"]


async def test_head_honours_if_none_match(http: AsyncClient) -> None:
    etag = (await http.get("/api/v1/products")).headers["etag"]

    response = await http.head("/api/v1/products", headers={"If-None-Match": etag})

    assert response.status_code == 304


async def test_head_on_an_error_has_no_body_either(http: AsyncClient) -> None:
    response = await http.head("/api/v1/products/missing")

    assert response.status_code == 404
    assert response.content == b""


@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/products/missing",  # not a 200
        "/api/v1/products/cookie",  # sets a cookie: per client
        "/api/v1/products/no-store",  # asked not to be kept
        "/api/v1/products/text",  # not JSON
        "/api/v1/productsx",  # shares a prefix, not a path segment
        "/api/v1/account/me",  # out of scope: depends on who is asking
    ],
)
async def test_responses_outside_the_rules_get_no_etag(http: AsyncClient, path: str) -> None:
    response = await http.get(path, headers={"If-None-Match": "*"})

    assert "etag" not in response.headers
    assert response.status_code != 304


async def test_post_is_never_conditional(http: AsyncClient) -> None:
    response = await http.post("/api/v1/products", headers={"If-None-Match": "*"})

    assert response.status_code == 405
    assert "etag" not in response.headers


# ── Compression ───────────────────────────────────────────────────────────────


async def test_a_large_json_body_is_gzipped_when_the_client_accepts_it(
    http: AsyncClient,
) -> None:
    response = await http.get("/api/v1/products", headers={"Accept-Encoding": "gzip"})

    assert response.headers["content-encoding"] == "gzip"
    assert "accept-encoding" in response.headers["vary"].lower()
    assert response.json() == CATALOG  # httpx decodes it
    # The validator describes the content, not the encoding: same either way.
    plain = await http.get("/api/v1/products", headers={"Accept-Encoding": "identity"})
    assert "content-encoding" not in plain.headers
    assert plain.headers["etag"] == response.headers["etag"]


async def test_a_streamed_response_is_still_streamed_and_compressed(http: AsyncClient) -> None:
    response = await http.get("/api/v1/products/stream", headers={"Accept-Encoding": "gzip"})

    assert response.status_code == 200
    assert response.headers["content-encoding"] == "gzip"
    assert response.text.count("row") == 600


# ── The real app's wiring ─────────────────────────────────────────────────────


async def test_the_app_gzips_large_json(client: AsyncClient) -> None:
    response = await client.get("/openapi.json", headers={"Accept-Encoding": "gzip"})

    assert response.status_code == 200
    assert response.headers["content-encoding"] == "gzip"
    assert "accept-encoding" in response.headers["vary"].lower()


async def test_the_app_leaves_small_responses_uncompressed(client: AsyncClient) -> None:
    response = await client.get("/health", headers={"Accept-Encoding": "gzip"})

    assert "content-encoding" not in response.headers


async def test_the_app_does_not_tag_reads_outside_the_catalog(client: AsyncClient) -> None:
    response = await client.get("/openapi.json")

    assert "etag" not in response.headers
