"""The wishlist (PLANNING.md 10.5): save, list, remove — a toggle that never errors."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager

import pytest

from tests.integration.catalog_support import product, variant
from tests.integration.conftest import Browser, sign_in_as

pytestmark = pytest.mark.integration

NewBrowser = Callable[[], AbstractAsyncContextManager[Browser]]


async def test_save_list_and_remove(admin: Browser, new_browser: NewBrowser) -> None:
    lamp = await product(admin, "Desk Lamp", variants=[variant(price=5000)])
    chair = await product(admin, "Chair", variants=[variant(price=9000)])
    async with new_browser() as ada:
        await sign_in_as(ada, "ada@example.com")
        for saved in (lamp, chair, lamp):  # saving twice is saving once
            response = await ada.post("/api/v1/account/wishlist", json={"product_id": saved["id"]})
            assert response.status_code == 204, response.text
        listed = await ada.get("/api/v1/account/wishlist")
        assert [card["title"] for card in listed.json()] == ["Chair", "Desk Lamp"]  # newest first

        for _ in range(2):  # removing twice is fine too
            gone = await ada.delete(f"/api/v1/account/wishlist/{lamp['id']}")
            assert gone.status_code == 204
        assert [c["title"] for c in (await ada.get("/api/v1/account/wishlist")).json()] == ["Chair"]


async def test_only_published_products_and_only_your_own(
    admin: Browser, new_browser: NewBrowser
) -> None:
    draft = await product(admin, "Secret", variants=[variant()], status="draft")
    async with new_browser() as ada:
        await sign_in_as(ada, "ada@example.com")
        hidden = await ada.post("/api/v1/account/wishlist", json={"product_id": draft["id"]})
        assert hidden.status_code == 404
        missing = await ada.post("/api/v1/account/wishlist", json={"product_id": str(uuid.uuid4())})
        assert missing.status_code == 404
    async with new_browser() as anonymous:
        assert (await anonymous.get("/api/v1/account/wishlist")).status_code == 401
