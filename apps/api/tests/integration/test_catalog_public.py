"""The storefront's catalog reads (PLANNING.md Phase 6.1, API-SPEC.md §2 "Catalog")."""

from __future__ import annotations

import pytest

from tests.integration.catalog_support import (
    category,
    collection,
    pages,
    problem,
    product,
    sql,
    variant,
)
from tests.integration.conftest import Browser

pytestmark = pytest.mark.integration


async def test_only_live_products_are_listed(admin: Browser, browser: Browser) -> None:
    live = await product(admin, "Live Tee")
    await product(admin, "Draft Tee", status="draft")
    archived = await product(admin, "Archived Tee")
    await admin.patch(f"/api/v1/admin/products/{archived['id']}", json={"status": "archived"})

    slugs = [item["slug"] for item in await pages(browser, "/api/v1/products")]

    assert slugs == [live["slug"]]
    assert (await browser.get("/api/v1/products/draft-tee")).status_code == 404


@pytest.mark.parametrize("sort", ["newest", "price", "-price", "rating"])
async def test_cursor_pages_cover_everything_once(
    admin: Browser, browser: Browser, sort: str
) -> None:
    # Duplicate prices, so the id tie-break is what keeps pages disjoint.
    for n in range(9):
        await product(admin, f"Paged Tee {n}", variants=[variant(price=1000 + (n % 3) * 100)])

    items = await pages(browser, "/api/v1/products", sort=sort, limit=2)

    assert len(items) == 9
    assert len({item["id"] for item in items}) == 9
    prices = [item["price"]["amount"] for item in items]
    if sort == "price":
        assert prices == sorted(prices)
    if sort == "-price":
        assert prices == sorted(prices, reverse=True)


async def test_a_cursor_from_another_sort_or_mangled_is_refused(
    admin: Browser, browser: Browser
) -> None:
    for n in range(3):
        await product(admin, f"Cursor Tee {n}")
    first = await browser.get("/api/v1/products", params={"sort": "price", "limit": 1})
    cursor = first.json()["pagination"]["next_cursor"]

    other_sort = await browser.get("/api/v1/products", params={"sort": "newest", "cursor": cursor})
    mangled = await browser.get("/api/v1/products", params={"cursor": "not-a-cursor"})

    assert (other_sort.status_code, problem(other_sort)) == (400, "invalid-cursor")
    assert (mangled.status_code, problem(mangled)) == (400, "invalid-cursor")


async def test_filters_narrow_the_listing(admin: Browser, browser: Browser) -> None:
    await category(admin, "Apparel")
    await category(admin, "Tops", parent="apparel")
    await category(admin, "Footwear")
    tee = await product(
        admin, "Filter Tee", category="tops", brand="Kestrel", variants=[variant(price=2500)]
    )
    await product(
        admin, "Filter Runner", category="footwear", brand="Velo", variants=[variant(price=12000)]
    )
    sold_out = await product(
        admin,
        "Filter Hoodie",
        category="tops",
        brand="Velo",
        variants=[variant(price=7000, stock=0)],
    )
    await collection(admin, "Picks", [tee["id"]])

    async def slugs(**params: object) -> set[str]:
        return {item["slug"] for item in await pages(browser, "/api/v1/products", **params)}

    # A parent category includes its descendants.
    assert await slugs(category="apparel") == {"filter-tee", "filter-hoodie"}
    assert await slugs(collection="picks") == {"filter-tee"}
    assert await slugs(brand="Velo") == {"filter-runner", "filter-hoodie"}
    assert await slugs(min_price=5000, max_price=10000) == {"filter-hoodie"}
    assert await slugs(in_stock="true") == {"filter-tee", "filter-runner"}
    assert await slugs(in_stock="false") == {sold_out["slug"]}
    unknown = await browser.get("/api/v1/products", params={"category": "nope"})
    assert unknown.status_code == 404


async def test_product_detail_shows_exact_stock_only_when_low(
    admin: Browser, browser: Browser
) -> None:
    await product(
        admin,
        "Detail Crew",
        brand="Northbound",
        variants=[
            variant(
                price=8900,
                compare_at=11900,
                stock=3,
                options={"Size": "M", "Colour": "Navy"},
                swatches={"Navy": "#1e293b"},
            ),
            variant(price=8900, stock=500, options={"Size": "L", "Colour": "Navy"}),
            variant(price=8900, stock=0, options={"Size": "S", "Colour": "Navy"}),
        ],
    )

    body = (await browser.get("/api/v1/products/detail-crew")).json()

    by_size = {v["option_values"]["Size"]: v for v in body["variants"]}
    assert by_size["M"]["availability"] == {"in_stock": True, "quantity_available": 3}
    # Above the threshold the exact count is withheld (API-SPEC.md §2).
    assert by_size["L"]["availability"] == {"in_stock": True, "quantity_available": None}
    assert by_size["S"]["availability"] == {"in_stock": False, "quantity_available": 0}
    assert by_size["M"]["price"] == {"amount": 8900, "currency": "USD"}
    assert by_size["M"]["compare_at"] == {"amount": 11900, "currency": "USD"}
    colour = next(option for option in body["options"] if option["name"] == "Colour")
    assert colour["values"] == [{"value": "Navy", "swatch_hex": "#1e293b"}]
    assert body["in_stock"] is True
    assert body["seo"]["title"] == "Detail Crew — Northbound"


async def test_an_edit_is_visible_at_once_despite_the_cache(
    admin: Browser, browser: Browser
) -> None:
    created = await product(admin, "Cached Tee", variants=[variant(price=2800)])
    variant_id = created["variants"][0]["id"]
    assert (await browser.get("/api/v1/products/cached-tee")).json()["variants"][0]["price"][
        "amount"
    ] == 2800  # now cached

    await admin.patch(f"/api/v1/admin/variants/{variant_id}", json={"price": 2400})
    await admin.patch(f"/api/v1/admin/products/{created['id']}", json={"slug": "cached-tee-v2"})

    assert (await browser.get("/api/v1/products/cached-tee")).status_code == 404
    moved = (await browser.get("/api/v1/products/cached-tee-v2")).json()
    assert moved["variants"][0]["price"]["amount"] == 2400
    listed = await pages(browser, "/api/v1/products")
    assert [item["slug"] for item in listed] == ["cached-tee-v2"]


async def test_related_products_share_the_category_tree(admin: Browser, browser: Browser) -> None:
    await category(admin, "Apparel")
    await category(admin, "Tops", parent="apparel")
    await category(admin, "Bottoms", parent="apparel")
    await category(admin, "Bags")
    await product(admin, "Anchor Tee", category="tops")
    await product(admin, "Sibling Chino", category="bottoms")
    await product(admin, "Other Tote", category="bags")
    await product(admin, "Sold Out Shirt", category="tops", variants=[variant(stock=0)])

    related = (await browser.get("/api/v1/products/anchor-tee/related")).json()

    assert [item["slug"] for item in related] == ["sibling-chino"]


async def test_categories_nest_and_carry_breadcrumbs(admin: Browser, browser: Browser) -> None:
    await category(admin, "Apparel")
    await category(admin, "Tops", parent="apparel")
    await category(admin, "Tees", parent="tops")
    await product(admin, "Crumb Tee", category="tees")

    tree = (await browser.get("/api/v1/categories")).json()
    page = (await browser.get("/api/v1/categories/tops")).json()
    detail = (await browser.get("/api/v1/products/crumb-tee")).json()

    assert tree[0]["slug"] == "apparel"
    assert tree[0]["children"][0]["children"][0]["slug"] == "tees"
    assert [crumb["slug"] for crumb in page["breadcrumbs"]] == ["apparel", "tops"]
    assert [child["slug"] for child in page["children"]] == ["tees"]
    assert [item["slug"] for item in page["products"]["data"]] == ["crumb-tee"]
    assert [crumb["slug"] for crumb in detail["breadcrumbs"]] == ["apparel", "tops", "tees"]
    assert (await browser.get("/api/v1/categories/nope")).status_code == 404


async def test_only_active_collections_are_public(admin: Browser, browser: Browser) -> None:
    tee = await product(admin, "Collected Tee")
    await collection(admin, "Summer", [tee["id"]])
    await collection(admin, "Hidden", [tee["id"]], is_active=False)

    listed = (await browser.get("/api/v1/collections")).json()
    page = (await browser.get("/api/v1/collections/summer")).json()

    assert [item["slug"] for item in listed] == ["summer"]
    assert [item["slug"] for item in page["products"]["data"]] == ["collected-tee"]
    assert (await browser.get("/api/v1/collections/hidden")).status_code == 404


async def test_a_deleted_product_is_gone_but_its_row_remains(
    admin: Browser, browser: Browser
) -> None:
    created = await product(admin, "Gone Tee")

    response = await admin.delete(f"/api/v1/admin/products/{created['id']}")

    assert response.status_code == 204
    assert (await browser.get("/api/v1/products/gone-tee")).status_code == 404
    # Soft delete: order history can still resolve it (DATA-MODEL.md §4).
    assert await sql("SELECT deleted_at IS NOT NULL FROM products WHERE slug = 'gone-tee'")
