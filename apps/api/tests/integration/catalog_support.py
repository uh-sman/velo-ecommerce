"""Building catalog data for tests through the admin API, as an operator would."""

from __future__ import annotations

import itertools
from typing import Any

from sqlalchemy import NullPool, text
from sqlalchemy.ext.asyncio import create_async_engine

from tests.conftest import TEST_ENV
from tests.integration.conftest import Browser

_sku = itertools.count(1)


def next_sku(prefix: str = "T") -> str:
    return f"{prefix}-{next(_sku):05d}"


def variant(
    price: int = 2800,
    *,
    stock: int = 10,
    options: dict[str, str] | None = None,
    **extra: Any,
) -> dict[str, Any]:
    return {
        "sku": extra.pop("sku", next_sku()),
        "price": price,
        "stock": stock,
        "options": options or {},
        **extra,
    }


async def category(
    admin: Browser, name: str, parent: str | None = None, **extra: Any
) -> dict[str, Any]:
    body: dict[str, Any] = {"name": name, **extra}
    if parent:
        body["parent"] = parent
    response = await admin.post("/api/v1/admin/categories", json=body)
    assert response.status_code == 201, response.text
    return dict(response.json())


async def product(
    admin: Browser,
    title: str,
    *,
    variants: list[dict[str, Any]] | None = None,
    status: str = "active",
    **extra: Any,
) -> dict[str, Any]:
    response = await admin.post(
        "/api/v1/admin/products",
        json={
            "title": title,
            "status": status,
            "variants": variants if variants is not None else [variant()],
            **extra,
        },
    )
    assert response.status_code == 201, response.text
    return dict(response.json())


async def collection(
    admin: Browser, title: str, products: list[str], **extra: Any
) -> dict[str, Any]:
    response = await admin.post(
        "/api/v1/admin/collections", json={"title": title, "products": products, **extra}
    )
    assert response.status_code == 201, response.text
    return dict(response.json())


def problem(response: Any) -> str:
    """The stable slug of a problem response: https://velo.dev/errors/sku-taken → sku-taken."""
    return str(response.json()["type"]).rsplit("/", 1)[-1]


async def sql(statement: str, **params: Any) -> Any:
    engine = create_async_engine(TEST_ENV["VELO_DATABASE_URL"], poolclass=NullPool)
    async with engine.begin() as connection:
        result = await connection.execute(text(statement), params)
        value = result.scalar() if result.returns_rows else None
    await engine.dispose()
    return value


async def pages(browser: Browser, path: str, **params: Any) -> list[dict[str, Any]]:
    """Every item of a cursor-paginated list, following next_cursor to the end."""
    items: list[dict[str, Any]] = []
    cursor: str | None = None
    for _ in range(100):
        query = {**params, **({"cursor": cursor} if cursor else {})}
        response = await browser.get(path, params=query)
        assert response.status_code == 200, response.text
        body = response.json()
        items.extend(body["data"])
        cursor = body["pagination"]["next_cursor"]
        if not cursor:
            return items
    raise AssertionError("pagination did not end")
