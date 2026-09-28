"""Search: indexing by the worker, relevance, facets, degradation (PLANNING.md Phase 6.3)."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest

from tests.integration.catalog_support import category, product, sql, variant
from tests.integration.conftest import Browser, drain
from velo.core.config import get_settings
from velo.core.meili import MeiliClient
from velo.db.session import session_scope
from velo.domains.catalog import search as search_module
from velo.domains.catalog.search import SearchIndexer, SearchQuery, SearchService

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _closed_breaker() -> Iterator[None]:
    """The breaker is per process; a test that trips it must not leak."""
    search_module.breaker.reset()
    yield
    search_module.breaker.reset()


async def seed_catalog(admin: Browser) -> None:
    await category(admin, "Apparel")
    await category(admin, "Tops", parent="apparel")
    await category(admin, "Footwear")
    await product(
        admin,
        "Merino Crew",
        brand="Northbound",
        category="tops",
        description="Extra-fine merino wool.",
        variants=[
            variant(price=9800, options={"Colour": "Navy", "Size": "M"}),
            variant(price=9800, options={"Colour": "Olive", "Size": "L"}),
        ],
    )
    await product(
        admin,
        "Harbour Tee",
        brand="Velo",
        category="tops",
        variants=[variant(price=2800, options={"Colour": "Navy", "Size": "S"})],
    )
    await product(
        admin,
        "Trail Runner",
        brand="Kestrel",
        category="footwear",
        variants=[variant(price=12800, stock=0, options={"Colour": "Black", "Size": "9"})],
    )


async def search(browser: Browser, **params: Any) -> dict[str, Any]:
    response = await browser.get("/api/v1/search", params=params)
    assert response.status_code == 200, response.text
    return dict(response.json())


async def test_the_worker_indexes_catalog_writes(
    admin: Browser, browser: Browser, worker_ctx: dict[str, Any]
) -> None:
    await seed_catalog(admin)
    await drain(worker_ctx)

    everything = await search(browser)
    typo = await search(browser, q="merno")  # one typo
    synonym = await search(browser, q="t-shirt")

    assert everything["degraded"] is False
    assert everything["total_hits"] == 3
    assert [hit["slug"] for hit in typo["hits"]] == ["merino-crew"]
    assert [hit["slug"] for hit in synonym["hits"]] == ["harbour-tee"]
    assert await sql("SELECT count(*) FROM outbox_events WHERE published_at IS NULL") == 0


async def test_facets_count_and_filters_narrow(
    admin: Browser, browser: Browser, worker_ctx: dict[str, Any]
) -> None:
    await seed_catalog(admin)
    await drain(worker_ctx)

    all_hits = await search(browser)
    navy = await search(browser, colour="Navy")
    apparel_in_stock = await search(browser, category="apparel", in_stock="true", sort="price")
    under_50 = await search(browser, max_price=5000)

    assert all_hits["facets"]["brand"] == {"Northbound": 1, "Velo": 1, "Kestrel": 1}
    assert all_hits["facets"]["colour"] == {"Navy": 2, "Olive": 1, "Black": 1}
    assert {hit["slug"] for hit in navy["hits"]} == {"merino-crew", "harbour-tee"}
    assert [hit["slug"] for hit in apparel_in_stock["hits"]] == ["harbour-tee", "merino-crew"]
    assert [hit["slug"] for hit in under_50["hits"]] == ["harbour-tee"]


async def test_unpublishing_and_deleting_remove_from_the_index(
    admin: Browser, browser: Browser, worker_ctx: dict[str, Any]
) -> None:
    tee = await product(admin, "Vanishing Tee")
    shirt = await product(admin, "Vanishing Shirt")
    await drain(worker_ctx)
    assert (await search(browser, q="vanishing"))["total_hits"] == 2

    await admin.patch(f"/api/v1/admin/products/{tee['id']}", json={"status": "draft"})
    await admin.delete(f"/api/v1/admin/products/{shirt['id']}")
    await drain(worker_ctx)

    assert (await search(browser, q="vanishing"))["total_hits"] == 0


async def test_stock_changes_reach_the_index(
    admin: Browser, browser: Browser, worker_ctx: dict[str, Any]
) -> None:
    created = await product(admin, "Restocked Runner", variants=[variant(stock=0)])
    await drain(worker_ctx)
    assert (await search(browser, q="restocked", in_stock="true"))["total_hits"] == 0

    await admin.post(
        f"/api/v1/admin/inventory/{created['variants'][0]['id']}/adjust",
        json={"delta": 4, "reason": "restock"},
    )
    await drain(worker_ctx)

    assert (await search(browser, q="restocked", in_stock="true"))["total_hits"] == 1


async def test_suggestions_complete_a_prefix(
    admin: Browser, browser: Browser, worker_ctx: dict[str, Any]
) -> None:
    await seed_catalog(admin)
    await drain(worker_ctx)

    response = await browser.get("/api/v1/search/suggest", params={"q": "harb"})

    assert [s["slug"] for s in response.json()] == ["harbour-tee"]
    assert (await browser.get("/api/v1/search/suggest", params={"q": ""})).json() == []


async def test_search_falls_back_to_postgres_when_meilisearch_is_down(
    admin: Browser, browser: Browser, live_app: Any
) -> None:
    await seed_catalog(admin)
    dead = MeiliClient(get_settings().model_copy(update={"meilisearch_url": "http://127.0.0.1:9"}))
    from velo.api.deps import get_meili

    live_app.dependency_overrides[get_meili] = lambda: dead
    try:
        results = await search(browser, q="merino", colour="Navy")
        tripped = search_module.breaker.is_open
        suggestions = (await browser.get("/api/v1/search/suggest", params={"q": "harb"})).json()
    finally:
        del live_app.dependency_overrides[get_meili]
        await dead.aclose()

    assert results["degraded"] is True
    assert [hit["slug"] for hit in results["hits"]] == ["merino-crew"]
    assert results["facets"]["colour"] == {"Navy": 1, "Olive": 1}
    assert tripped is True  # later searches skip the dead engine for a while
    assert [s["slug"] for s in suggestions] == ["harbour-tee"]


async def test_the_fallback_and_the_engine_agree_on_filters(
    admin: Browser, worker_ctx: dict[str, Any]
) -> None:
    await seed_catalog(admin)
    await drain(worker_ctx)
    settings = get_settings()
    queries = [
        SearchQuery(q="merino"),
        SearchQuery(brands=("Velo", "Kestrel")),
        SearchQuery(categories=("apparel",), colours=("Navy",)),
        SearchQuery(in_stock=False),
        SearchQuery(min_price=3000, max_price=10000),
    ]
    async with session_scope() as session:
        engine = SearchService(session, worker_ctx["worker"].meili, settings.meilisearch_index)
        fallback = SearchService(session, None, settings.meilisearch_index)
        for query in queries:
            fast, slow = await engine.search(query), await fallback.search(query)
            assert {h.slug for h in fast.hits} == {h.slug for h in slow.hits}, query
            assert fast.total_hits == slow.total_hits, query


async def test_index_events_wait_while_meilisearch_is_down(
    admin: Browser, worker_ctx: dict[str, Any]
) -> None:
    worker = worker_ctx["worker"]
    healthy = worker.meili
    worker.meili = MeiliClient(
        get_settings().model_copy(update={"meilisearch_url": "http://127.0.0.1:9"}), timeout=0.5
    )
    await product(admin, "Patient Tee")
    try:
        totals = await drain(worker_ctx)
        pending = await sql("SELECT count(*) FROM outbox_events WHERE published_at IS NULL")
        attempts = await sql("SELECT max(attempts) FROM outbox_events")
    finally:
        await worker.meili.aclose()
        worker.meili = healthy

    assert totals["deferred"] >= 1
    assert pending >= 1
    assert attempts == 0  # deferred, not failed: nothing is lost or dead-lettered
    await drain(worker_ctx)
    assert await sql("SELECT count(*) FROM outbox_events WHERE published_at IS NULL") == 0


async def test_a_rebuild_swaps_in_a_complete_index(
    admin: Browser, browser: Browser, worker_ctx: dict[str, Any]
) -> None:
    from velo.worker import rebuild_index

    await seed_catalog(admin)  # indexed by nothing yet: the relay has not run
    result = await rebuild_index(worker_ctx["worker"])
    async with session_scope() as session:
        indexer = SearchIndexer(
            session, worker_ctx["worker"].meili, get_settings().meilisearch_index
        )
        missing, stale = await indexer.differences()

    assert result["indexed"] == result["live_products"] == 3
    assert (missing, stale) == ([], [])
    assert (await search(browser, q="runner"))["total_hits"] == 1


async def test_search_is_rate_limited_per_ip(browser: Browser, worker_ctx: dict[str, Any]) -> None:
    statuses = [(await browser.get("/api/v1/search")).status_code for _ in range(61)]
    limited = await browser.get("/api/v1/search")

    assert statuses[:60] == [200] * 60
    assert statuses[60] == 429
    assert "Retry-After" in limited.headers
