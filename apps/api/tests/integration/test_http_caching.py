"""Compression, ETags and caching headers on the real routes (PLANNING.md Phase 14)."""

from __future__ import annotations

import pytest

from tests.integration.catalog_support import product
from tests.integration.conftest import Browser

pytestmark = pytest.mark.integration


async def test_a_large_catalog_listing_is_gzipped(admin: Browser, browser: Browser) -> None:
    for n in range(6):
        await product(admin, f"Gzip Tee {n}")

    response = await browser.get("/api/v1/products", headers={"Accept-Encoding": "gzip"})

    assert response.status_code == 200
    assert response.headers["content-encoding"] == "gzip"
    assert "accept-encoding" in response.headers["vary"].lower()
    assert len(response.json()["data"]) == 6


async def test_catalog_reads_carry_an_etag_and_revalidate_to_304(
    admin: Browser, browser: Browser
) -> None:
    tee = await product(admin, "Etag Tee")
    path = f"/api/v1/products/{tee['slug']}"

    first = await browser.get(path)
    etag = first.headers["etag"]
    revalidated = await browser.get(path, headers={"If-None-Match": etag})

    assert first.headers["cache-control"].startswith("public")
    assert (revalidated.status_code, revalidated.content) == (304, b"")
    assert revalidated.headers["etag"] == etag


async def test_an_edit_changes_the_etag(admin: Browser, browser: Browser) -> None:
    tee = await product(admin, "Edited Tee")
    path = f"/api/v1/products/{tee['slug']}"
    etag = (await browser.get(path)).headers["etag"]

    await admin.patch(f"/api/v1/admin/products/{tee['id']}", json={"description": "Now longer."})
    after = await browser.get(path, headers={"If-None-Match": etag})

    assert after.status_code == 200
    assert after.headers["etag"] != etag
    assert after.json()["description"] == "Now longer."


@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/products",
        "/api/v1/products/{slug}/related",
        "/api/v1/products/{slug}/reviews",
        "/api/v1/products/{slug}/reviews/summary",
        "/api/v1/collections",
        "/api/v1/categories",
    ],
)
async def test_every_public_catalog_read_is_cacheable_and_tagged(
    admin: Browser, browser: Browser, path: str
) -> None:
    tee = await product(admin, "Public Tee")

    response = await browser.get(path.format(slug=tee["slug"]))

    assert response.status_code == 200, response.text
    assert response.headers["cache-control"].startswith("public")
    assert response.headers["etag"].startswith('W/"')


async def test_head_works_on_catalog_reads(admin: Browser, browser: Browser) -> None:
    tee = await product(admin, "Head Tee")
    path = f"/api/v1/products/{tee['slug']}"
    plain = {"Accept-Encoding": "identity"}

    get = await browser.get(path, headers=plain)
    head = await browser.client.head(path, headers=plain)
    missing = await browser.client.head("/api/v1/products/no-such-tee")

    assert (head.status_code, head.content) == (200, b"")
    assert head.headers["etag"] == get.headers["etag"]
    assert head.headers["content-length"] == get.headers["content-length"]
    assert (missing.status_code, missing.content) == (404, b"")


async def test_search_is_tagged_but_kept_out_of_shared_caches(browser: Browser) -> None:
    first = await browser.get("/api/v1/search/suggest", params={"q": "tee"})
    again = await browser.get(
        "/api/v1/search/suggest",
        params={"q": "tee"},
        headers={"If-None-Match": first.headers["etag"]},
    )

    # Each search counts against the caller's own rate limit, so no CDN copy.
    assert first.headers["cache-control"] == "private, no-cache"
    assert again.status_code == 304


async def test_a_public_read_never_hands_out_a_csrf_cookie(browser: Browser) -> None:
    """A CDN would replay that one token to every visitor."""
    response = await browser.get("/api/v1/categories")

    assert response.status_code == 200
    assert "set-cookie" not in response.headers
    # The token is still one request away for a client that needs it.
    await browser.ensure_csrf()
    assert browser.csrf


async def test_signed_in_reads_are_never_tagged_or_shared(admin: Browser) -> None:
    for path in ("/api/v1/auth/me", "/api/v1/account/addresses", "/api/v1/cart"):
        response = await admin.get(path, headers={"If-None-Match": "*"})

        assert response.status_code == 200, (path, response.text)
        assert "etag" not in response.headers, path
        assert "public" not in response.headers.get("cache-control", ""), path
