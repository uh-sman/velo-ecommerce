"""Product search — Meilisearch first, Postgres full-text when it cannot answer (ADR-007).

**Serving.** :class:`SearchService` asks Meilisearch. A refused connection, a
timeout, or an error opens a short circuit breaker and the same query is
answered from Postgres instead, marked ``degraded``. While the breaker is open
no request waits on the dead engine; afterwards one request probes it again.

**Indexing.** The index is derived, never authoritative. :class:`SearchIndexer`
turns products into documents and is driven by the outbox relay, so a catalog
write never waits on the search engine. A full reindex builds a fresh index
beside the live one and swaps them atomically, so it is safe against
production: searches keep being answered from the old index until the swap.

Prices and stock in the index are display hints; the product page and the cart
always read Postgres.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from velo.core.logging import get_logger
from velo.core.meili import MeiliClient, SearchUnavailableError
from velo.core.pagination import MoneyJson
from velo.domains.catalog.repository import (
    CatalogRepository,
    CategoryRecord,
    ListingFilter,
    ProductSummary,
)
from velo.domains.catalog.views import MediaView, ProductCard, RatingView

logger = get_logger(__name__)

SearchSort = Literal["relevance", "price", "-price", "newest", "rating"]
SUGGEST_LIMIT = 8
BREAKER_SECONDS = 15.0
BATCH_SIZE = 500

# Option names indexed as facets. Matched case-insensitively; "Color" counts.
COLOUR_OPTIONS = ("colour", "color")
SIZE_OPTIONS = ("size",)

INDEX_SETTINGS: dict[str, Any] = {
    # Order matters: a match in the title outranks one in the description.
    "searchableAttributes": ["title", "brand", "category", "colour", "subtitle", "description"],
    "filterableAttributes": [
        "brand",
        "category_slug",
        "category_slugs",
        "collections",
        "colour",
        "size",
        "price",
        "in_stock",
        "rating",
    ],
    "sortableAttributes": ["price", "published_at", "rating"],
    # Meilisearch's defaults, then best-rated as the final tie-break.
    "rankingRules": ["words", "typo", "proximity", "attribute", "sort", "exactness", "rating:desc"],
    "synonyms": {
        "tee": ["t-shirt", "tshirt"],
        "t-shirt": ["tee"],
        "tshirt": ["tee"],
        "hoodie": ["sweatshirt", "hoody"],
        "sweatshirt": ["hoodie"],
        "sneaker": ["trainer", "shoe"],
        "trainer": ["sneaker"],
        "runner": ["running shoe", "sneaker"],
        "chino": ["trousers", "pants"],
        "trousers": ["chino", "pants"],
        "pants": ["trousers", "chino"],
        "jacket": ["coat"],
        "coat": ["jacket"],
        "cap": ["hat"],
        "beanie": ["hat", "toque"],
        "bag": ["tote", "backpack"],
        "backpack": ["daypack", "bag"],
        "grey": ["gray"],
        "gray": ["grey"],
    },
    "stopWords": ["a", "an", "and", "the", "of", "for", "in", "on", "with", "to"],
    "typoTolerance": {"minWordSizeForTypos": {"oneTypo": 4, "twoTypos": 8}},
    "faceting": {"maxValuesPerFacet": 100, "sortFacetValuesBy": {"*": "count"}},
    "pagination": {"maxTotalHits": 5000},
}

_SORTS: dict[str, list[str]] = {
    "relevance": [],
    "price": ["price:asc"],
    "-price": ["price:desc"],
    "newest": ["published_at:desc"],
    "rating": ["rating:desc"],
}
# Facets as the API names them → the document attribute behind each.
_FACETS = {"brand": "brand", "category": "category_slug", "colour": "colour", "size": "size"}


# ── Circuit breaker ───────────────────────────────────────────────────────────


class _Breaker:
    """Per process. Opens on a failure; the first call after it expires probes again."""

    def __init__(self) -> None:
        self._open_until = 0.0

    @property
    def is_open(self) -> bool:
        return time.monotonic() < self._open_until

    def trip(self) -> None:
        self._open_until = time.monotonic() + BREAKER_SECONDS

    def reset(self) -> None:
        self._open_until = 0.0


breaker = _Breaker()


# ── Queries and results ───────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class SearchQuery:
    q: str = ""
    brands: tuple[str, ...] = ()
    categories: tuple[str, ...] = ()  # slugs; a category matches its descendants too
    collections: tuple[str, ...] = ()
    colours: tuple[str, ...] = ()
    sizes: tuple[str, ...] = ()
    min_price: int | None = None
    max_price: int | None = None
    in_stock: bool | None = None
    sort: SearchSort = "relevance"
    limit: int = 24
    offset: int = 0


class SearchResults(BaseModel):
    query: str
    hits: list[ProductCard]
    facets: dict[str, dict[str, int]]
    total_hits: int
    limit: int
    offset: int
    processing_time_ms: int
    # True when answered by the Postgres fallback: relevance is plainer and
    # typos are not forgiven, but the shopper still gets results.
    degraded: bool


class Suggestion(BaseModel):
    title: str
    slug: str


def _quote(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _any_of(attribute: str, values: tuple[str, ...]) -> str:
    return f"{attribute} IN [{', '.join(_quote(value) for value in values)}]"


def meili_filter(query: SearchQuery) -> list[str]:
    """Meilisearch filter clauses; the list is ANDed."""
    clauses: list[str] = []
    if query.brands:
        clauses.append(_any_of("brand", query.brands))
    if query.categories:
        clauses.append(_any_of("category_slugs", query.categories))
    if query.collections:
        clauses.append(_any_of("collections", query.collections))
    if query.colours:
        clauses.append(_any_of("colour", query.colours))
    if query.sizes:
        clauses.append(_any_of("size", query.sizes))
    if query.min_price is not None:
        clauses.append(f"price >= {int(query.min_price)}")
    if query.max_price is not None:
        clauses.append(f"price <= {int(query.max_price)}")
    if query.in_stock is not None:
        clauses.append(f"in_stock = {'true' if query.in_stock else 'false'}")
    return clauses


def card_from_document(document: dict[str, Any]) -> ProductCard:
    currency = document.get("currency") or "USD"
    image = document.get("image")
    rating = document.get("rating") or 0
    return ProductCard(
        id=uuid.UUID(document["id"]),
        slug=document["slug"],
        title=document["title"],
        subtitle=document.get("subtitle"),
        brand=document.get("brand"),
        price=MoneyJson(amount=int(document["price"]), currency=currency),
        price_max=MoneyJson(
            amount=int(document.get("price_max", document["price"])), currency=currency
        ),
        compare_at=(
            MoneyJson(amount=int(document["compare_at"]), currency=currency)
            if document.get("compare_at")
            else None
        ),
        in_stock=bool(document.get("in_stock")),
        rating=(
            RatingView(average=float(rating), count=int(document.get("rating_count", 0)))
            if rating and document.get("rating_count")
            else None
        ),
        image=MediaView.model_validate(image) if image else None,
        published_at=(
            datetime.fromtimestamp(document["published_at"]).astimezone()
            if document.get("published_at")
            else None
        ),
    )


# ── Serving ───────────────────────────────────────────────────────────────────


class SearchService:
    def __init__(self, session: AsyncSession, meili: MeiliClient | None, index: str) -> None:
        self._catalog = CatalogRepository(session)
        self._meili = meili
        self._index = index

    async def search(self, query: SearchQuery) -> SearchResults:
        if self._meili is not None and not breaker.is_open:
            try:
                results = await self._search_meili(query)
            except SearchUnavailableError as exc:
                breaker.trip()
                logger.warning("search_degraded", reason=str(exc)[:300])
            else:
                breaker.reset()
                return results
        return await self._search_postgres(query)

    async def _search_meili(self, query: SearchQuery) -> SearchResults:
        assert self._meili is not None
        body: dict[str, Any] = {
            "q": query.q,
            "filter": meili_filter(query),
            "facets": list(_FACETS.values()),
            "limit": query.limit,
            "offset": query.offset,
            "attributesToRetrieve": [
                "id",
                "slug",
                "title",
                "subtitle",
                "brand",
                "price",
                "price_max",
                "compare_at",
                "currency",
                "in_stock",
                "rating",
                "rating_count",
                "image",
                "published_at",
            ],
        }
        if _SORTS[query.sort]:
            body["sort"] = _SORTS[query.sort]
        data = await self._meili.search(self._index, body)
        distribution: dict[str, dict[str, int]] = data.get("facetDistribution") or {}
        return SearchResults(
            query=query.q,
            hits=[card_from_document(hit) for hit in data.get("hits", [])],
            facets={name: distribution.get(attribute, {}) for name, attribute in _FACETS.items()},
            total_hits=int(data.get("estimatedTotalHits", data.get("totalHits", 0))),
            limit=query.limit,
            offset=query.offset,
            processing_time_ms=int(data.get("processingTimeMs", 0)),
            degraded=False,
        )

    async def _search_postgres(self, query: SearchQuery) -> SearchResults:
        started = time.perf_counter()
        filters = await self._postgres_filter(query)
        items: list[ProductSummary] = []
        total = 0
        facets: dict[str, dict[str, int]] = {name: {} for name in _FACETS}
        if filters is not None:  # None: an unknown category slug matches nothing
            ids = await self._catalog.matching_ids(filters)
            items, total = await self._catalog.text_search(
                filters, sort=query.sort, limit=query.limit, offset=query.offset, ids=ids
            )
            counts = await self._catalog.facet_counts(filters, ["Colour", "Color", "Size"], ids=ids)
            colours = counts.get("colour", {})
            for value, count in counts.get("color", {}).items():
                colours[value] = colours.get(value, 0) + count
            facets = {
                "brand": counts.get("brand", {}),
                "category": counts.get("category", {}),
                "colour": colours,
                "size": counts.get("size", {}),
            }
        return SearchResults(
            query=query.q,
            hits=[ProductCard.of(item) for item in items],
            facets=facets,
            total_hits=total,
            limit=query.limit,
            offset=query.offset,
            processing_time_ms=int((time.perf_counter() - started) * 1000),
            degraded=True,
        )

    async def _postgres_filter(self, query: SearchQuery) -> ListingFilter | None:
        category_path: str | None = None
        if query.categories:
            # The fallback takes the first category only; Meilisearch takes all.
            category = await self._catalog.category(slug=query.categories[0])
            if category is None:
                return None
            category_path = category.path
        options: list[tuple[str, tuple[str, ...]]] = []
        if query.colours:
            options.append(("Colour", query.colours))
        if query.sizes:
            options.append(("Size", query.sizes))
        return ListingFilter(
            category_path=category_path,
            collection_slug=query.collections[0] if query.collections else None,
            brands=query.brands,
            min_price=query.min_price,
            max_price=query.max_price,
            in_stock=query.in_stock,
            options=tuple(options),
            text_query=query.q.strip() or None,
        )

    async def suggest(self, prefix: str) -> list[Suggestion]:
        prefix = prefix.strip()
        if not prefix:
            return []
        if self._meili is not None and not breaker.is_open:
            try:
                data = await self._meili.search(
                    self._index,
                    {
                        "q": prefix,
                        "limit": SUGGEST_LIMIT,
                        "attributesToRetrieve": ["title", "slug"],
                        "filter": ["in_stock = true"],
                    },
                )
            except SearchUnavailableError as exc:
                breaker.trip()
                logger.warning("search_degraded", reason=str(exc)[:300])
            else:
                breaker.reset()
                return [Suggestion(title=hit["title"], slug=hit["slug"]) for hit in data["hits"]]
        return [
            Suggestion(title=title, slug=slug)
            for title, slug in await self._catalog.title_suggestions(prefix, SUGGEST_LIMIT)
        ]


# ── Indexing ──────────────────────────────────────────────────────────────────


def _option(options: dict[str, list[str]], names: tuple[str, ...]) -> list[str]:
    values: list[str] = []
    for name, found in options.items():
        if name.lower() in names:
            values.extend(found)
    return sorted(set(values))


def _ancestors(
    category: CategoryRecord | None, by_id: dict[uuid.UUID, CategoryRecord]
) -> list[str]:
    slugs: list[str] = []
    while category is not None:
        slugs.append(category.slug)
        category = by_id.get(category.parent_id) if category.parent_id else None
    return slugs


class SearchIndexer:
    def __init__(self, session: AsyncSession, meili: MeiliClient, index: str) -> None:
        self._catalog = CatalogRepository(session)
        self._meili = meili
        self._index = index

    async def documents(self, product_ids: list[uuid.UUID]) -> list[dict[str, Any]]:
        """Index documents for the live products among ``product_ids``."""
        summaries = await self._catalog.summaries(product_ids)
        if not summaries:
            return []
        live_ids = [summary.id for summary in summaries]
        records = {record.id: record for record in await self._catalog.products_by_ids(live_ids)}
        options = await self._catalog.option_values_by_product(live_ids)
        collections = await self._catalog.collection_slugs(live_ids)
        categories = {category.id: category for category in await self._catalog.categories()}

        documents = []
        for summary in summaries:
            record = records[summary.id]
            category = categories.get(summary.category_id) if summary.category_id else None
            product_options = options.get(summary.id, {})
            documents.append(
                {
                    "id": str(summary.id),
                    "slug": summary.slug,
                    "title": summary.title,
                    "subtitle": summary.subtitle,
                    "brand": summary.brand,
                    "description": (record.description or "")[:2000],
                    "category": category.name if category else None,
                    "category_slug": category.slug if category else None,
                    "category_slugs": _ancestors(category, categories),
                    "collections": collections.get(summary.id, []),
                    "colour": _option(product_options, COLOUR_OPTIONS),
                    "size": _option(product_options, SIZE_OPTIONS),
                    "price": summary.price_min,
                    "price_max": summary.price_max,
                    "compare_at": (
                        summary.compare_at_max
                        if summary.compare_at_max and summary.compare_at_max > summary.price_min
                        else None
                    ),
                    "currency": summary.currency,
                    "in_stock": summary.in_stock,
                    "rating": float(summary.rating_average or 0),
                    "rating_count": summary.rating_count,
                    "published_at": (
                        int(summary.published_at.timestamp()) if summary.published_at else 0
                    ),
                    "image": (
                        MediaView.of(summary.image).model_dump(mode="json")
                        if summary.image
                        else None
                    ),
                }
            )
        return documents

    async def ensure_index(self, uid: str | None = None) -> None:
        uid = uid or self._index
        if not await self._meili.index_exists(uid):
            await self._meili.wait_for_task(await self._meili.create_index(uid))
        await self._meili.wait_for_task(await self._meili.update_settings(uid, INDEX_SETTINGS))

    async def sync(self, product_ids: list[uuid.UUID], *, wait: bool = False) -> tuple[int, int]:
        """Upsert the live ones, delete the rest. Returns (upserted, deleted)."""
        if not product_ids:
            return 0, 0
        documents = await self.documents(product_ids)
        live = {document["id"] for document in documents}
        gone = [str(pid) for pid in product_ids if str(pid) not in live]
        tasks = []
        if documents:
            tasks.append(await self._meili.add_documents(self._index, documents))
        if gone:
            tasks.append(await self._meili.delete_documents(self._index, gone))
        if wait:
            for task in tasks:
                await self._meili.wait_for_task(task)
        return len(documents), len(gone)

    async def rebuild(self, *, since_hook: Any = None) -> dict[str, Any]:
        """Build a fresh index from Postgres and swap it in. Zero downtime.

        ``since_hook`` is awaited after the swap with the build's start time, so
        the caller can re-sync anything written while the build ran — those
        writes went to the old index.
        """
        started_at = datetime.now().astimezone()
        building = f"{self._index}_build_{int(time.time())}"
        await self.ensure_index(building)
        product_ids = await self._catalog.live_product_ids()
        tasks = []
        for start in range(0, len(product_ids), BATCH_SIZE):
            documents = await self.documents(product_ids[start : start + BATCH_SIZE])
            if documents:
                tasks.append(await self._meili.add_documents(building, documents))
        for task in tasks:
            await self._meili.wait_for_task(task, max_seconds=600)

        built = await self._meili.document_count(building)
        if not await self._meili.index_exists(self._index):
            await self._meili.wait_for_task(await self._meili.create_index(self._index))
        await self._meili.wait_for_task(await self._meili.swap_indexes(self._index, building))
        # After the swap `building` holds the previous contents; drop it.
        deleted = await self._meili.delete_index(building)
        if deleted is not None:
            await self._meili.wait_for_task(deleted)
        caught_up = 0
        if since_hook is not None:
            caught_up = await since_hook(started_at)
        return {"indexed": built, "live_products": len(product_ids), "caught_up": caught_up}

    async def differences(self) -> tuple[list[uuid.UUID], list[uuid.UUID]]:
        """Reconciliation: live products the index lacks, and documents it should not have."""
        indexed = {uuid.UUID(value) for value in await self._meili.document_ids(self._index)}
        live = set(await self._catalog.live_product_ids())
        return sorted(live - indexed, key=str), sorted(indexed - live, key=str)
