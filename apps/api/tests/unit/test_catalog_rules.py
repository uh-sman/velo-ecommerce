"""Catalog and search logic that needs no database (PLANNING.md Phase 6)."""

from __future__ import annotations

import io
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import httpx
import pytest
from PIL import Image

from velo.core.config import Settings
from velo.core.meili import MeiliClient, SearchUnavailableError
from velo.core.pagination import InvalidCursorError, decode_cursor, encode_cursor
from velo.domains.catalog import search as search_module
from velo.domains.catalog.admin import slugify
from velo.domains.catalog.csv_io import from_minor, to_minor
from velo.domains.catalog.images import InvalidImageError, blurhash, process
from velo.domains.catalog.repository import CategoryRecord
from velo.domains.catalog.search import SearchQuery, card_from_document, meili_filter
from velo.domains.catalog.service import build_tree

# ── Cursors ───────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "key",
    [2999, "SKU-001", Decimal("4.50"), datetime(2026, 9, 28, 12, 30, tzinfo=UTC)],
)
def test_a_cursor_round_trips_its_key_with_the_right_type(key: Any) -> None:
    row_id = uuid.uuid4()

    decoded_key, decoded_id = decode_cursor(encode_cursor("price", key, row_id), "price")

    assert (decoded_key, decoded_id) == (key, row_id)
    assert type(decoded_key) is type(key)


def test_a_cursor_is_bound_to_its_sort() -> None:
    cursor = encode_cursor("price", 100, uuid.uuid4())

    with pytest.raises(InvalidCursorError, match="different sort"):
        decode_cursor(cursor, "newest")


@pytest.mark.parametrize("cursor", ["", "!!!", "eyJ9", "bm90IGpzb24"])
def test_a_mangled_cursor_is_refused(cursor: str) -> None:
    with pytest.raises(InvalidCursorError):
        decode_cursor(cursor, "price")


# ── Money in CSV ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("text", "minor"),
    [("29.99", 2999), ("29.9", 2990), ("30", 3000), ("1,250.00", 125000), ("0.01", 1)],
)
def test_csv_amounts_become_minor_units(text: str, minor: int) -> None:
    assert to_minor(text) == minor


@pytest.mark.parametrize("text", ["12.999", "-1.00"])
def test_csv_amounts_are_checked(text: str) -> None:
    with pytest.raises(ValueError, match=r"decimal places|negative"):
        to_minor(text)


def test_minor_units_export_with_two_places() -> None:
    assert (from_minor(2999), from_minor(5), from_minor(None)) == ("29.99", "0.05", "")


# ── Slugs ─────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("title", "slug"),
    [
        ("Merino Crew — Navy", "merino-crew-navy"),
        ("Café Crème 2.0", "cafe-creme-2-0"),
        ("  --Tee!!  ", "tee"),
        ("✨", "item"),
    ],
)
def test_slugify(title: str, slug: str) -> None:
    assert slugify(title) == slug


# ── Search filters and the engine ─────────────────────────────────────────────


def test_filters_are_quoted_and_escaped() -> None:
    clauses = meili_filter(
        SearchQuery(
            brands=('Bob"s', "A\\B"),
            colours=("Navy",),
            min_price=1000,
            max_price=5000,
            in_stock=True,
        )
    )

    assert clauses == [
        'brand IN ["Bob\\"s", "A\\\\B"]',
        'colour IN ["Navy"]',
        "price >= 1000",
        "price <= 5000",
        "in_stock = true",
    ]


def test_a_filter_value_cannot_escape_its_quotes() -> None:
    clause = meili_filter(SearchQuery(brands=('x"] OR brand EXISTS OR ["',)))[0]

    # The injected quote is escaped: the whole thing stays one string value.
    assert clause == 'brand IN ["x\\"] OR brand EXISTS OR [\\""]'


async def test_searches_go_out_as_get_with_the_filter_joined() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"hits": [], "estimatedTotalHits": 0})

    settings = Settings(
        secret_key="x" * 40, database_url="postgresql+asyncpg://u:p@h/db", _env_file=None
    )
    client = MeiliClient(settings)
    client._search = httpx.AsyncClient(
        base_url="http://meili", transport=httpx.MockTransport(handler)
    )

    await client.search(
        "products",
        {"q": "tee", "filter": ["a = 1", "b = 2"], "facets": ["brand", "size"], "sort": []},
    )

    request = seen[0]
    assert request.method == "GET"
    assert request.content == b""
    assert dict(request.url.params) == {
        "q": "tee",
        "filter": "(a = 1) AND (b = 2)",
        "facets": "brand,size",
    }
    await client.aclose()


async def test_every_engine_failure_is_one_exception() -> None:
    settings = Settings(
        secret_key="x" * 40, database_url="postgresql+asyncpg://u:p@h/db", _env_file=None
    )
    client = MeiliClient(settings)

    def boom(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="overloaded")

    client._search = httpx.AsyncClient(base_url="http://m", transport=httpx.MockTransport(boom))
    with pytest.raises(SearchUnavailableError, match="503"):
        await client.search("products", {"q": ""})

    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    client._search = httpx.AsyncClient(base_url="http://m", transport=httpx.MockTransport(refuse))
    with pytest.raises(SearchUnavailableError, match="refused"):
        await client.search("products", {"q": ""})
    await client.aclose()


def test_the_breaker_opens_and_closes() -> None:
    breaker = search_module._Breaker()
    states = [breaker.is_open]
    breaker.trip()
    states.append(breaker.is_open)
    breaker.reset()
    states.append(breaker.is_open)

    assert states == [False, True, False]


def test_a_search_document_becomes_a_product_card() -> None:
    card = card_from_document(
        {
            "id": str(uuid.uuid4()),
            "slug": "tee",
            "title": "Tee",
            "price": 2800,
            "price_max": 3200,
            "compare_at": 3500,
            "currency": "USD",
            "in_stock": True,
            "rating": 4.5,
            "rating_count": 2,
            "published_at": 1_790_000_000,
        }
    )

    assert card.price.amount == 2800
    assert card.compare_at is not None and card.compare_at.amount == 3500
    assert card.rating is not None and card.rating.average == 4.5
    assert card.image is None


# ── Categories ────────────────────────────────────────────────────────────────


def test_categories_nest_in_position_order() -> None:
    root, child_b, child_a, grandchild = (uuid.uuid4() for _ in range(4))
    records = [
        CategoryRecord(grandchild, child_a, "tees", "Tees", "apparel.tops.tees", 0),
        CategoryRecord(child_b, root, "bottoms", "Bottoms", "apparel.bottoms", 2),
        CategoryRecord(root, None, "apparel", "Apparel", "apparel", 0),
        CategoryRecord(child_a, root, "tops", "Tops", "apparel.tops", 1),
    ]

    tree = build_tree(records)

    assert [node.slug for node in tree] == ["apparel"]
    assert [node.slug for node in tree[0].children] == ["tops", "bottoms"]
    assert [node.slug for node in tree[0].children[0].children] == ["tees"]


# ── Images ────────────────────────────────────────────────────────────────────


def _image(width: int, height: int, fmt: str = "PNG") -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), (200, 60, 40)).save(buffer, fmt)
    return buffer.getvalue()


def test_renditions_never_upscale() -> None:
    result = process(_image(700, 350))

    assert (result.width, result.height) == (700, 350)
    assert sorted({r.width for r in result.renditions}) == [320, 640, 700]
    assert {r.format for r in result.renditions} == {"avif", "webp"}
    assert all(r.height == round(350 * r.width / 700) for r in result.renditions)


def test_large_originals_are_capped_at_the_widest_rendition() -> None:
    result = process(_image(2400, 1200, "JPEG"))

    assert max(r.width for r in result.renditions) == 1920


def test_anything_that_is_not_an_image_is_refused() -> None:
    with pytest.raises(InvalidImageError):
        process(b"<svg onload=alert(1)>")


def test_a_blurhash_has_the_documented_length_and_encodes_the_colour() -> None:
    solid = Image.new("RGB", (64, 64), (255, 0, 0))

    code = blurhash(solid)

    assert len(code) == 28  # 1 + 1 + 4 + 2 x (4 x 3 - 1) components
    # The DC term is the average colour: 0xFF0000 = 16711680, which in base 83 is
    # the digits 29, 18, 70, 45 -> "T", "I", ":", "j".
    assert code[2:6] == "TI:j"
