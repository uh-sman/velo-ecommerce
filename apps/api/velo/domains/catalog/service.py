"""Catalog reads for the storefront: listings, product detail, categories, collections.

Every read goes through :class:`CatalogCache`. Stock comes from the inventory
domain's service (ARCHITECTURE.md §3, rule 5), and is shown as the storefront
may show it: exact counts only when low.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import asdict, dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from velo.core.errors import NotFoundError
from velo.core.pagination import CursorPage, MoneyJson, PaginationInfo, decode_cursor, encode_cursor
from velo.domains.catalog.cache import CatalogCache
from velo.domains.catalog.repository import (
    CatalogRepository,
    CategoryRecord,
    ListingFilter,
    ProductRecord,
    SortKey,
)
from velo.domains.catalog.views import (
    AvailabilityView,
    CategoryNode,
    CategoryRef,
    CollectionView,
    MediaView,
    OptionValueView,
    OptionView,
    ProductCard,
    ProductDetail,
    RatingView,
    SeoView,
    VariantView,
)
from velo.domains.inventory.service import InventoryService

RELATED_LIMIT = 8


@dataclass(frozen=True, slots=True)
class ListingQuery:
    """What a shopper asked for. Slugs, not ids: they come from URLs."""

    category: str | None = None
    collection: str | None = None
    brands: tuple[str, ...] = ()
    min_price: int | None = None
    max_price: int | None = None
    in_stock: bool | None = None
    sort: SortKey = "newest"
    limit: int = 24
    cursor: str | None = None

    def cache_name(self) -> str:
        raw = json.dumps(asdict(self), sort_keys=True, default=str)
        return "list:" + hashlib.sha256(raw.encode()).hexdigest()[:32]


class CatalogService:
    def __init__(
        self, session: AsyncSession, cache: CatalogCache, inventory: InventoryService
    ) -> None:
        self._catalog = CatalogRepository(session)
        self._cache = cache
        self._inventory = inventory

    # ── Listings ──────────────────────────────────────────────────────────

    async def list_products(self, query: ListingQuery) -> CursorPage[ProductCard]:
        async def load() -> CursorPage[ProductCard]:
            return await self._list(query)

        return await self._cache.get_or_load(
            await self._cache.versioned_key(query.cache_name()),
            load,
            lambda page: page.model_dump(mode="json"),
            CursorPage[ProductCard].model_validate,
        )

    async def _list(self, query: ListingQuery) -> CursorPage[ProductCard]:
        category_path: str | None = None
        if query.category is not None:
            category = await self._catalog.category(slug=query.category)
            if category is None:
                raise NotFoundError("No such category.")
            category_path = category.path
        if (
            query.collection is not None
            and await self._catalog.collection(slug=query.collection) is None
        ):
            raise NotFoundError("No such collection.")

        after = decode_cursor(query.cursor, query.sort) if query.cursor else None
        page = await self._catalog.list_products(
            ListingFilter(
                category_path=category_path,
                collection_slug=query.collection,
                brands=query.brands,
                min_price=query.min_price,
                max_price=query.max_price,
                in_stock=query.in_stock,
            ),
            sort=query.sort,
            limit=query.limit,
            after=after,
        )
        next_cursor = (
            encode_cursor(query.sort, page.next_key[0], page.next_key[1]) if page.next_key else None
        )
        return CursorPage[ProductCard](
            data=[ProductCard.of(item) for item in page.items],
            pagination=PaginationInfo(
                next_cursor=next_cursor, has_more=next_cursor is not None, limit=query.limit
            ),
        )

    async def cards(self, product_ids: list[uuid.UUID]) -> list[ProductCard]:
        """Live products by id, in order — for search results."""
        return [ProductCard.of(item) for item in await self._catalog.summaries(product_ids)]

    # ── One product ───────────────────────────────────────────────────────

    async def product(self, slug: str) -> ProductDetail:
        async def load() -> ProductDetail | None:
            record = await self._catalog.product_by_slug(slug)
            return await self._detail(record) if record else None

        detail = await self._cache.get_or_load(
            self._cache.product_key(slug),
            load,
            lambda value: value.model_dump(mode="json") if value else None,
            ProductDetail.model_validate,
        )
        if detail is None:
            raise NotFoundError("No such product.")
        return detail

    async def _detail(self, product: ProductRecord) -> ProductDetail:
        options = await self._catalog.options(product.id)
        variants = await self._catalog.variants([product.id])
        media = await self._catalog.media(product.id)
        availability = await self._inventory.availability([variant.id for variant in variants])
        breadcrumbs = await self._breadcrumbs(product.category_id)

        variant_views = []
        for variant in variants:
            stock = availability[variant.id]
            variant_views.append(
                VariantView(
                    id=variant.id,
                    sku=variant.sku,
                    title=variant.title,
                    price=MoneyJson(amount=variant.price_amount, currency=variant.price_currency),
                    compare_at=(
                        MoneyJson(amount=variant.compare_at_amount, currency=variant.price_currency)
                        if variant.compare_at_amount is not None
                        else None
                    ),
                    option_values=variant.option_values,
                    availability=AvailabilityView(
                        in_stock=stock.in_stock, quantity_available=stock.quantity_available
                    ),
                )
            )
        return ProductDetail(
            id=product.id,
            slug=product.slug,
            title=product.title,
            subtitle=product.subtitle,
            brand=product.brand,
            description=product.description,
            attributes=product.attributes,
            category=breadcrumbs[-1] if breadcrumbs else None,
            breadcrumbs=breadcrumbs,
            rating=(
                RatingView(average=float(product.rating_average), count=product.rating_count)
                if product.rating_average is not None and product.rating_count
                else None
            ),
            in_stock=any(view.availability.in_stock for view in variant_views),
            options=[
                OptionView(
                    name=option.name,
                    values=[
                        OptionValueView(value=value.value, swatch_hex=value.swatch_hex)
                        for value in option.values
                    ],
                )
                for option in options
            ],
            variants=variant_views,
            media=[MediaView.of(item) for item in media],
            seo=SeoView(
                title=product.seo_title
                or (f"{product.title} — {product.brand}" if product.brand else product.title),
                description=product.seo_description or product.subtitle,
            ),
        )

    async def related(self, slug: str, limit: int = RELATED_LIMIT) -> list[ProductCard]:
        """Same category (or its parent's tree), best rated first, in stock first."""
        product = await self._catalog.product_by_slug(slug)
        if product is None:
            raise NotFoundError("No such product.")
        if product.category_id is None:
            return []
        category = await self._catalog.category(category_id=product.category_id)
        if category is None:
            return []
        path = category.path.rsplit(".", 1)[0] if "." in category.path else category.path
        page = await self._catalog.list_products(
            ListingFilter(category_path=path, exclude_id=product.id, in_stock=True),
            sort="rating",
            limit=limit,
            after=None,
        )
        return [ProductCard.of(item) for item in page.items]

    async def variant_of(self, slug: str, variant_id: uuid.UUID) -> uuid.UUID:
        """The variant, checked to belong to this live product."""
        product = await self._catalog.product_by_slug(slug)
        variant = await self._catalog.variant(variant_id)
        if product is None or variant is None or variant.product_id != product.id:
            raise NotFoundError("No such product variant.")
        return variant.id

    async def product_id(self, slug: str) -> uuid.UUID:
        product = await self._catalog.product_by_slug(slug)
        if product is None:
            raise NotFoundError("No such product.")
        return product.id

    # ── Categories and collections ────────────────────────────────────────

    async def category_tree(self) -> list[CategoryNode]:
        async def load() -> list[CategoryNode]:
            return build_tree(await self._catalog.categories())

        return await self._cache.get_or_load(
            await self._cache.versioned_key("categories"),
            load,
            lambda nodes: [node.model_dump(mode="json") for node in nodes],
            lambda data: [CategoryNode.model_validate(item) for item in data],
        )

    async def category(
        self, slug: str
    ) -> tuple[CategoryRef, list[CategoryRef], list[CategoryNode]]:
        """The category, its breadcrumbs, and its direct children."""
        category = await self._catalog.category(slug=slug)
        if category is None:
            raise NotFoundError("No such category.")
        breadcrumbs = await self._breadcrumbs(category.id)
        subtree = build_tree(
            [item for item in await self._catalog.categories() if item.parent_id == category.id],
            root_parent=category.id,
        )
        return CategoryRef(slug=category.slug, name=category.name), breadcrumbs, subtree

    async def _breadcrumbs(self, category_id: uuid.UUID | None) -> list[CategoryRef]:
        if category_id is None:
            return []
        categories = {item.id: item for item in await self._catalog.categories()}
        trail: list[CategoryRef] = []
        current = categories.get(category_id)
        while current is not None:
            trail.append(CategoryRef(slug=current.slug, name=current.name))
            current = categories.get(current.parent_id) if current.parent_id else None
        return list(reversed(trail))

    async def collections(self) -> list[CollectionView]:
        async def load() -> list[CollectionView]:
            return [
                CollectionView(id=c.id, slug=c.slug, title=c.title, description=c.description)
                for c in await self._catalog.collections()
            ]

        return await self._cache.get_or_load(
            await self._cache.versioned_key("collections"),
            load,
            lambda views: [view.model_dump(mode="json") for view in views],
            lambda data: [CollectionView.model_validate(item) for item in data],
        )

    async def collection(self, slug: str) -> CollectionView:
        collection = await self._catalog.collection(slug=slug)
        if collection is None:
            raise NotFoundError("No such collection.")
        return CollectionView(
            id=collection.id,
            slug=collection.slug,
            title=collection.title,
            description=collection.description,
        )


def build_tree(
    categories: list[CategoryRecord], root_parent: uuid.UUID | None = None
) -> list[CategoryNode]:
    """Nest a flat list by ``parent_id``, keeping each level in position order."""
    children: dict[uuid.UUID | None, list[CategoryRecord]] = {}
    for category in sorted(categories, key=lambda item: (item.position, item.name)):
        children.setdefault(category.parent_id, []).append(category)

    def nodes(parent: uuid.UUID | None) -> list[CategoryNode]:
        return [
            CategoryNode(id=item.id, slug=item.slug, name=item.name, children=nodes(item.id))
            for item in children.get(parent, [])
        ]

    return nodes(root_parent)
