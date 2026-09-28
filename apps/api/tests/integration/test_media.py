"""Product media: presigned upload, attach, derivatives (PLANNING.md Phase 6.1)."""

from __future__ import annotations

import io
from typing import Any

import httpx
import pytest
from PIL import Image

from tests.integration.catalog_support import problem, product
from tests.integration.conftest import Browser, drain

pytestmark = pytest.mark.integration


def png(width: int = 1200, height: int = 1500) -> bytes:
    image = Image.new("RGB", (width, height), (15, 118, 110))
    for y in range(0, height, 60):
        for x in range(width):
            image.putpixel((x, y), (240, 240, 230))
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


async def upload(
    admin: Browser, product_id: str, data: bytes, content_type: str = "image/png"
) -> str:
    presigned = await admin.post(
        "/api/v1/admin/media/presign",
        json={"product_id": product_id, "content_type": content_type},
    )
    assert presigned.status_code == 200, presigned.text
    body = presigned.json()
    async with httpx.AsyncClient() as storage:
        response = await storage.post(
            body["url"], data=body["fields"], files={"file": ("upload", data, content_type)}
        )
    if response.status_code >= 300 and response.status_code != 307:
        pytest.skip(f"object storage is not reachable: {response.status_code}")
    return str(body["key"])


async def test_an_upload_becomes_renditions_and_a_placeholder(
    admin: Browser, browser: Browser, worker_ctx: dict[str, Any]
) -> None:
    created = await product(admin, "Pictured Jacket")
    key = await upload(admin, created["id"], png())

    attached = await admin.post(
        f"/api/v1/admin/products/{created['id']}/media",
        json={"key": key, "alt_text": "Teal jacket, front"},
    )
    await drain(worker_ctx)
    media = (await browser.get("/api/v1/products/pictured-jacket")).json()["media"]

    assert attached.status_code == 201
    assert len(media) == 1
    image = media[0]
    assert (image["width"], image["height"]) == (1200, 1500)
    assert image["blurhash"] and len(image["blurhash"]) == 28
    assert image["alt_text"] == "Teal jacket, front"
    assert {(r["width"], r["format"]) for r in image["renditions"]} == {
        (w, f) for w in (320, 640, 960, 1200) for f in ("avif", "webp")
    }
    async with httpx.AsyncClient() as client:
        served = await client.get(image["renditions"][0]["url"])
    assert served.status_code == 200
    assert served.headers["content-type"] in ("image/avif", "image/webp")


async def test_a_file_that_is_not_an_image_is_discarded(
    admin: Browser, browser: Browser, worker_ctx: dict[str, Any]
) -> None:
    created = await product(admin, "Tricked Tee")
    key = await upload(admin, created["id"], b"<html>not a picture</html>")

    await admin.post(
        f"/api/v1/admin/products/{created['id']}/media", json={"key": key, "alt_text": "Nope"}
    )
    await drain(worker_ctx)

    assert (await browser.get("/api/v1/products/tricked-tee")).json()["media"] == []


async def test_attach_checks_the_upload_and_its_owner(admin: Browser) -> None:
    mine = await product(admin, "Owner Tee")
    theirs = await product(admin, "Other Tee")
    key = await upload(admin, theirs["id"], png(400, 400))

    not_uploaded = await admin.post(
        f"/api/v1/admin/products/{mine['id']}/media",
        json={"key": f"products/{mine['id']}/missing/original.png", "alt_text": "x"},
    )
    wrong_product = await admin.post(
        f"/api/v1/admin/products/{mine['id']}/media", json={"key": key, "alt_text": "x"}
    )
    no_alt = await admin.post(
        f"/api/v1/admin/products/{theirs['id']}/media", json={"key": key, "alt_text": ""}
    )

    assert (not_uploaded.status_code, problem(not_uploaded)) == (422, "invalid-media")
    assert (wrong_product.status_code, problem(wrong_product)) == (422, "invalid-media")
    assert no_alt.status_code == 422  # alt text is required (WCAG)


async def test_uploads_are_limited_to_images(admin: Browser) -> None:
    created = await product(admin, "Typed Tee")

    response = await admin.post(
        "/api/v1/admin/media/presign",
        json={"product_id": created["id"], "content_type": "text/html"},
    )

    assert response.status_code == 422


async def test_deleting_media_removes_it_and_its_files(
    admin: Browser, browser: Browser, worker_ctx: dict[str, Any]
) -> None:
    created = await product(admin, "Cleared Tee")
    key = await upload(admin, created["id"], png(400, 500))
    media = (
        await admin.post(
            f"/api/v1/admin/products/{created['id']}/media", json={"key": key, "alt_text": "x"}
        )
    ).json()
    await drain(worker_ctx)
    rendition_url = (await browser.get("/api/v1/products/cleared-tee")).json()["media"][0][
        "renditions"
    ][0]["url"]

    deleted = await admin.delete(f"/api/v1/admin/media/{media['id']}")
    await drain(worker_ctx)

    assert deleted.status_code == 204
    assert (await browser.get("/api/v1/products/cleared-tee")).json()["media"] == []
    async with httpx.AsyncClient() as client:
        assert (await client.get(rendition_url)).status_code == 404
