"""Catalog data access. Queries in, frozen records out — no rules, no HTTP.

Listing reads join ``inventory_items`` for the in-stock flag and filter. That
table belongs to the inventory domain, so it is named here as a bare table
clause, never imported as a model (ARCHITECTURE.md §3, rule 5): the catalog
reads one derived fact from it and never writes it.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any, Literal

from sqlalchemy import (
    ColumnElement,
    Select,
    Uuid,
    and_,
    any_,
    bindparam,
    case,
    column,
    delete,
    exists,
    false,
    func,
    literal,
    literal_column,
    or_,
    select,
    table,
    tuple_,
    update,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.ext.asyncio import AsyncSession

from velo.domains.catalog.models import (
    Category,
    Collection,
    OptionValue,
    Product,
    ProductCollection,
    ProductMedia,
    ProductOption,
    ProductVariant,
    Review,
    VariantOptionValue,
)

SortKey = Literal["newest", "price", "-price", "rating"]

# An order that was paid for: a review on it earns the verified-purchase badge.
PAID_ORDER_STATUSES = (
    "paid",
    "processing",
    "partially_fulfilled",
    "fulfilled",
    "delivered",
    "partially_refunded",
)

# The inventory domain's table, read-only (see the module docstring).
_inventory = table(
    "inventory_items",
    column("variant_id"),
    column("quantity_on_hand"),
    column("quantity_reserved"),
    column("track_inventory"),
    column("allow_backorder"),
)


# ── Records ───────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class MediaRecord:
    id: uuid.UUID
    product_id: uuid.UUID
    variant_id: uuid.UUID | None
    url: str
    alt_text: str | None
    width: int | None
    height: int | None
    blurhash: str | None
    media_type: str
    position: int
    renditions: tuple[dict[str, Any], ...] = ()


@dataclass(frozen=True, slots=True)
class ProductSummary:
    id: uuid.UUID
    slug: str
    title: str
    subtitle: str | None
    brand: str | None
    category_id: uuid.UUID | None
    rating_average: Decimal | None
    rating_count: int
    price_min: int
    price_max: int
    compare_at_max: int | None
    currency: str
    in_stock: bool
    published_at: datetime | None
    image: MediaRecord | None


@dataclass(frozen=True, slots=True)
class ProductRecord:
    id: uuid.UUID
    slug: str
    title: str
    subtitle: str | None
    description: str | None
    brand: str | None
    status: str
    category_id: uuid.UUID | None
    seo_title: str | None
    seo_description: str | None
    attributes: dict[str, Any]
    rating_average: Decimal | None
    rating_count: int
    published_at: datetime | None
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None


@dataclass(frozen=True, slots=True)
class OptionValueRecord:
    id: uuid.UUID
    value: str
    swatch_hex: str | None
    position: int


@dataclass(frozen=True, slots=True)
class OptionRecord:
    id: uuid.UUID
    name: str
    position: int
    values: tuple[OptionValueRecord, ...]


@dataclass(frozen=True, slots=True)
class VariantRecord:
    id: uuid.UUID
    product_id: uuid.UUID
    sku: str
    title: str
    price_amount: int
    price_currency: str
    compare_at_amount: int | None
    cost_amount: int | None
    weight_grams: int | None
    barcode: str | None
    requires_shipping: bool
    is_taxable: bool
    position: int
    option_values: dict[str, str]  # {"Size": "M", "Colour": "Navy"}


@dataclass(frozen=True, slots=True)
class CategoryRecord:
    id: uuid.UUID
    parent_id: uuid.UUID | None
    slug: str
    name: str
    path: str
    position: int


@dataclass(frozen=True, slots=True)
class CollectionRecord:
    id: uuid.UUID
    slug: str
    title: str
    description: str | None
    rules: dict[str, Any] | None
    is_active: bool


@dataclass(frozen=True, slots=True)
class ReviewRecord:
    id: uuid.UUID
    product_id: uuid.UUID
    user_id: uuid.UUID | None
    order_id: uuid.UUID | None
    rating: int
    title: str | None
    body: str | None
    status: str
    created_at: datetime
    author_name: str | None = None


@dataclass(frozen=True, slots=True)
class ListingFilter:
    category_path: str | None = None
    collection_slug: str | None = None
    brands: tuple[str, ...] = ()
    min_price: int | None = None
    max_price: int | None = None
    in_stock: bool | None = None
    exclude_id: uuid.UUID | None = None
    product_ids: tuple[uuid.UUID, ...] | None = None
    # (("Colour", ("Navy", "Olive")),) — any of the values per option; options AND together.
    options: tuple[tuple[str, tuple[str, ...]], ...] = ()
    text_query: str | None = None  # Postgres full-text: the search fallback


@dataclass(frozen=True, slots=True)
class Page:
    items: list[ProductSummary]
    next_key: tuple[Any, uuid.UUID] | None  # the last row's sort value and id


def _media(row: ProductMedia) -> MediaRecord:
    return MediaRecord(
        id=row.id,
        product_id=row.product_id,
        variant_id=row.variant_id,
        url=row.url,
        alt_text=row.alt_text,
        width=row.width,
        height=row.height,
        blurhash=row.blurhash,
        media_type=row.media_type,
        position=row.position,
        renditions=tuple(row.renditions or ()),
    )


def _product(row: Product) -> ProductRecord:
    return ProductRecord(
        id=row.id,
        slug=row.slug,
        title=row.title,
        subtitle=row.subtitle,
        description=row.description,
        brand=row.brand,
        status=row.status,
        category_id=row.category_id,
        seo_title=row.seo_title,
        seo_description=row.seo_description,
        attributes=dict(row.attributes or {}),
        rating_average=row.rating_average,
        rating_count=row.rating_count,
        published_at=row.published_at,
        created_at=row.created_at,
        updated_at=row.updated_at,
        deleted_at=row.deleted_at,
    )


def _category(row: Category) -> CategoryRecord:
    return CategoryRecord(
        id=row.id,
        parent_id=row.parent_id,
        slug=row.slug,
        name=row.name,
        path=row.path,
        position=row.position,
    )


def _collection(row: Collection) -> CollectionRecord:
    return CollectionRecord(
        id=row.id,
        slug=row.slug,
        title=row.title,
        description=row.description,
        rules=dict(row.rules) if row.rules is not None else None,
        is_active=row.is_active,
    )


def _review(row: Review, author_name: str | None = None) -> ReviewRecord:
    return ReviewRecord(
        id=row.id,
        product_id=row.product_id,
        user_id=row.user_id,
        order_id=row.order_id,
        rating=row.rating,
        title=row.title,
        body=row.body,
        status=row.status,
        created_at=row.created_at,
        author_name=author_name,
    )


def among(column: Any, ids: Sequence[uuid.UUID]) -> ColumnElement[bool]:
    """``column = ANY(:ids)`` — one array parameter, not one bind per id.

    An ``IN`` list of a thousand ids costs more to parse than to execute.
    """
    condition: ColumnElement[bool] = column == any_(
        bindparam(None, value=list(ids), type_=ARRAY(Uuid()))
    )
    return condition


def live_products() -> ColumnElement[bool]:
    """Visible on the storefront: active, not deleted, and published."""
    return and_(
        Product.status == "active",
        Product.deleted_at.is_(None),
        Product.published_at.is_not(None),
        Product.published_at <= func.now(),
    )


def variant_available() -> ColumnElement[bool]:
    """A variant can be bought: untracked, backorderable, or with stock left."""
    return or_(
        _inventory.c.track_inventory.is_(False),
        _inventory.c.allow_backorder.is_(True),
        _inventory.c.quantity_on_hand - _inventory.c.quantity_reserved > 0,
    )


# Written exactly as idx_products_fts is: Postgres uses an expression index only
# when the query's expression is textually the same.
_FTS_DOCUMENT = (
    "to_tsvector('english', products.title || ' ' || coalesce(products.description, ''))"
)


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _text_match(query_text: str) -> ColumnElement[bool]:
    """Full-text match, or a title substring, so a half-typed word still finds something."""
    fts = literal_column(_FTS_DOCUMENT).op("@@")(
        func.websearch_to_tsquery(literal_column("'english'"), query_text)
    )
    return or_(fts, Product.title.ilike(f"%{_escape_like(query_text)}%", escape="\\"))


def _text_rank(query_text: str) -> ColumnElement[Any]:
    return func.ts_rank(
        literal_column(_FTS_DOCUMENT),
        func.websearch_to_tsquery(literal_column("'english'"), query_text),
    )


class CatalogRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    # ── Listing ───────────────────────────────────────────────────────────

    @staticmethod
    def _product_conditions(query: Select[Any], filters: ListingFilter) -> Select[Any]:
        """Filters that need only the product row: cheap, and applied before any aggregate."""
        if filters.category_path is not None:
            descendants = select(Category.id).where(
                Category.path.op("<@")(func.text2ltree(filters.category_path))
            )
            query = query.where(Product.category_id.in_(descendants))
        if filters.collection_slug is not None:
            query = query.where(
                exists(
                    select(literal(1))
                    .select_from(ProductCollection)
                    .join(Collection, Collection.id == ProductCollection.collection_id)
                    .where(
                        ProductCollection.product_id == Product.id,
                        Collection.slug == filters.collection_slug,
                    )
                )
            )
        if filters.brands:
            query = query.where(Product.brand.in_(filters.brands))
        if filters.exclude_id is not None:
            query = query.where(Product.id != filters.exclude_id)
        if filters.product_ids is not None:
            query = query.where(among(Product.id, filters.product_ids))
        for option_name, values in filters.options:
            query = query.where(
                exists(
                    select(literal(1))
                    .select_from(ProductVariant)
                    .join(VariantOptionValue, VariantOptionValue.variant_id == ProductVariant.id)
                    .join(OptionValue, OptionValue.id == VariantOptionValue.option_value_id)
                    .join(ProductOption, ProductOption.id == OptionValue.option_id)
                    .where(
                        ProductVariant.product_id == Product.id,
                        ProductVariant.deleted_at.is_(None),
                        func.lower(ProductOption.name) == option_name.lower(),
                        OptionValue.value.in_(values),
                    )
                )
            )
        if filters.text_query:
            query = query.where(_text_match(filters.text_query))
        return query

    def _listing(self, filters: ListingFilter, *, include_hidden: bool = False) -> Select[Any]:
        stats_query = (
            select(
                ProductVariant.product_id.label("product_id"),
                func.min(ProductVariant.price_amount).label("price_min"),
                func.max(ProductVariant.price_amount).label("price_max"),
                func.max(ProductVariant.compare_at_amount).label("compare_at_max"),
                func.min(ProductVariant.price_currency).label("currency"),
                func.coalesce(func.bool_or(variant_available()), false()).label("in_stock"),
            )
            .outerjoin(_inventory, _inventory.c.variant_id == ProductVariant.id)
            .where(ProductVariant.deleted_at.is_(None))
            .group_by(ProductVariant.product_id)
        )
        if filters.product_ids is not None:
            # Aggregate only the variants asked about, not the whole catalog.
            stats_query = stats_query.where(among(ProductVariant.product_id, filters.product_ids))
        stats = stats_query.subquery("stats")
        query = select(
            Product.id,
            Product.slug,
            Product.title,
            Product.subtitle,
            Product.brand,
            Product.category_id,
            Product.rating_average,
            Product.rating_count,
            Product.published_at,
            stats.c.price_min,
            stats.c.price_max,
            stats.c.compare_at_max,
            stats.c.currency,
            stats.c.in_stock,
        ).join(stats, stats.c.product_id == Product.id)
        if not include_hidden:
            query = query.where(live_products())
        query = self._product_conditions(query, filters)
        if filters.min_price is not None:
            query = query.where(stats.c.price_min >= filters.min_price)
        if filters.max_price is not None:
            query = query.where(stats.c.price_min <= filters.max_price)
        if filters.in_stock is not None:
            query = query.where(stats.c.in_stock.is_(filters.in_stock))
        return query

    @staticmethod
    def _sort_column(query: Select[Any], sort: SortKey) -> tuple[ColumnElement[Any], bool]:
        """The keyset column for a sort, and whether it is ascending."""
        columns = query.selected_columns
        if sort == "price":
            return columns.price_min, True
        if sort == "-price":
            return columns.price_min, False
        if sort == "rating":
            return func.coalesce(columns.rating_average, 0), False
        return columns.published_at, False

    async def list_products(
        self,
        filters: ListingFilter,
        *,
        sort: SortKey,
        limit: int,
        after: tuple[Any, uuid.UUID] | None,
    ) -> Page:
        query = self._listing(filters)
        sort_column, ascending = self._sort_column(query, sort)
        query = query.add_columns(sort_column.label("sort_key"))
        id_column = query.selected_columns.id
        if after is not None:
            key, last_id = after
            position = tuple_(sort_column, id_column)
            boundary = tuple_(literal(key), literal(last_id))
            query = query.where(position > boundary if ascending else position < boundary)
        order = (
            (sort_column.asc(), id_column.asc())
            if ascending
            else (
                sort_column.desc(),
                id_column.desc(),
            )
        )
        rows = (await self._session.execute(query.order_by(*order).limit(limit + 1))).all()
        has_more = len(rows) > limit
        rows = rows[:limit]
        images = await self._primary_images([row.id for row in rows])
        items = [self._summary(row, images.get(row.id)) for row in rows]
        next_key = (rows[-1].sort_key, rows[-1].id) if has_more and rows else None
        return Page(items=items, next_key=next_key)

    async def summaries(self, product_ids: Sequence[uuid.UUID]) -> list[ProductSummary]:
        """Live products by id, in the order given (search results, related lists)."""
        if not product_ids:
            return []
        rows = (
            await self._session.execute(
                self._listing(ListingFilter(product_ids=tuple(product_ids)))
            )
        ).all()
        images = await self._primary_images([row.id for row in rows])
        by_id = {row.id: self._summary(row, images.get(row.id)) for row in rows}
        return [by_id[pid] for pid in product_ids if pid in by_id]

    async def count_products(self, filters: ListingFilter) -> int:
        count = await self._session.scalar(
            select(func.count()).select_from(self._listing(filters).subquery())
        )
        return int(count or 0)

    @staticmethod
    def _summary(row: Any, image: MediaRecord | None) -> ProductSummary:
        return ProductSummary(
            id=row.id,
            slug=row.slug,
            title=row.title,
            subtitle=row.subtitle,
            brand=row.brand,
            category_id=row.category_id,
            rating_average=row.rating_average,
            rating_count=row.rating_count,
            price_min=row.price_min,
            price_max=row.price_max,
            compare_at_max=row.compare_at_max,
            currency=row.currency,
            in_stock=bool(row.in_stock),
            published_at=row.published_at,
            image=image,
        )

    async def _primary_images(self, product_ids: list[uuid.UUID]) -> dict[uuid.UUID, MediaRecord]:
        if not product_ids:
            return {}
        rows = (
            await self._session.scalars(
                select(ProductMedia)
                .where(ProductMedia.product_id.in_(product_ids))
                .distinct(ProductMedia.product_id)
                .order_by(ProductMedia.product_id, ProductMedia.position, ProductMedia.id)
            )
        ).all()
        return {row.product_id: _media(row) for row in rows}

    # ── One product ───────────────────────────────────────────────────────

    async def product_by_slug(
        self, slug: str, *, include_hidden: bool = False
    ) -> ProductRecord | None:
        query = select(Product).where(Product.slug == slug)
        query = (
            query.where(Product.deleted_at.is_(None))
            if include_hidden
            else query.where(live_products())
        )
        row = await self._session.scalar(query)
        return _product(row) if row else None

    async def product_by_id(
        self, product_id: uuid.UUID, *, include_deleted: bool = False
    ) -> ProductRecord | None:
        query = select(Product).where(Product.id == product_id)
        if not include_deleted:
            query = query.where(Product.deleted_at.is_(None))
        row = await self._session.scalar(query)
        return _product(row) if row else None

    async def slug_taken(self, slug: str, *, except_id: uuid.UUID | None = None) -> bool:
        query = select(literal(1)).select_from(Product).where(Product.slug == slug)
        if except_id is not None:
            query = query.where(Product.id != except_id)
        return (await self._session.scalar(query.limit(1))) is not None

    async def options(self, product_id: uuid.UUID) -> list[OptionRecord]:
        options = (
            await self._session.scalars(
                select(ProductOption)
                .where(ProductOption.product_id == product_id)
                .order_by(ProductOption.position, ProductOption.name)
            )
        ).all()
        if not options:
            return []
        values = (
            await self._session.scalars(
                select(OptionValue)
                .where(OptionValue.option_id.in_([option.id for option in options]))
                .order_by(OptionValue.position, OptionValue.value)
            )
        ).all()
        by_option: dict[uuid.UUID, list[OptionValueRecord]] = {}
        for value in values:
            by_option.setdefault(value.option_id, []).append(
                OptionValueRecord(
                    id=value.id,
                    value=value.value,
                    swatch_hex=value.swatch_hex,
                    position=value.position,
                )
            )
        return [
            OptionRecord(
                id=option.id,
                name=option.name,
                position=option.position,
                values=tuple(by_option.get(option.id, [])),
            )
            for option in options
        ]

    async def variants(self, product_ids: Sequence[uuid.UUID]) -> list[VariantRecord]:
        if not product_ids:
            return []
        rows = (
            await self._session.scalars(
                select(ProductVariant)
                .where(
                    ProductVariant.product_id.in_(product_ids),
                    ProductVariant.deleted_at.is_(None),
                )
                .order_by(ProductVariant.product_id, ProductVariant.position, ProductVariant.sku)
            )
        ).all()
        option_values = await self._variant_option_values([row.id for row in rows])
        return [self._variant(row, option_values.get(row.id, {})) for row in rows]

    async def variant(self, variant_id: uuid.UUID) -> VariantRecord | None:
        row = await self._session.scalar(
            select(ProductVariant).where(
                ProductVariant.id == variant_id, ProductVariant.deleted_at.is_(None)
            )
        )
        if row is None:
            return None
        option_values = await self._variant_option_values([row.id])
        return self._variant(row, option_values.get(row.id, {}))

    async def sku_taken(self, sku: str, *, except_id: uuid.UUID | None = None) -> bool:
        query = select(literal(1)).select_from(ProductVariant).where(ProductVariant.sku == sku)
        if except_id is not None:
            query = query.where(ProductVariant.id != except_id)
        return (await self._session.scalar(query.limit(1))) is not None

    @staticmethod
    def _variant(row: ProductVariant, option_values: dict[str, str]) -> VariantRecord:
        return VariantRecord(
            id=row.id,
            product_id=row.product_id,
            sku=row.sku,
            title=row.title,
            price_amount=row.price_amount,
            price_currency=row.price_currency,
            compare_at_amount=row.compare_at_amount,
            cost_amount=row.cost_amount,
            weight_grams=row.weight_grams,
            barcode=row.barcode,
            requires_shipping=row.requires_shipping,
            is_taxable=row.is_taxable,
            position=row.position,
            option_values=option_values,
        )

    async def _variant_option_values(
        self, variant_ids: list[uuid.UUID]
    ) -> dict[uuid.UUID, dict[str, str]]:
        if not variant_ids:
            return {}
        rows = (
            await self._session.execute(
                select(VariantOptionValue.variant_id, ProductOption.name, OptionValue.value)
                .join(OptionValue, OptionValue.id == VariantOptionValue.option_value_id)
                .join(ProductOption, ProductOption.id == OptionValue.option_id)
                .where(VariantOptionValue.variant_id.in_(variant_ids))
                .order_by(ProductOption.position)
            )
        ).all()
        result: dict[uuid.UUID, dict[str, str]] = {}
        for variant_id, name, value in rows:
            result.setdefault(variant_id, {})[name] = value
        return result

    async def media(self, product_id: uuid.UUID) -> list[MediaRecord]:
        rows = (
            await self._session.scalars(
                select(ProductMedia)
                .where(ProductMedia.product_id == product_id)
                .order_by(ProductMedia.position, ProductMedia.id)
            )
        ).all()
        return [_media(row) for row in rows]

    async def media_item(self, media_id: uuid.UUID) -> MediaRecord | None:
        row = await self._session.get(ProductMedia, media_id)
        return _media(row) if row else None

    async def collection_slugs(
        self, product_ids: Sequence[uuid.UUID]
    ) -> dict[uuid.UUID, list[str]]:
        if not product_ids:
            return {}
        rows = (
            await self._session.execute(
                select(ProductCollection.product_id, Collection.slug)
                .join(Collection, Collection.id == ProductCollection.collection_id)
                .where(ProductCollection.product_id.in_(product_ids))
                .order_by(Collection.slug)
            )
        ).all()
        result: dict[uuid.UUID, list[str]] = {}
        for product_id, slug in rows:
            result.setdefault(product_id, []).append(slug)
        return result

    # ── Categories and collections ────────────────────────────────────────

    async def categories(self) -> list[CategoryRecord]:
        rows = (
            await self._session.scalars(
                select(Category)
                .order_by(Category.position, Category.name)
                .execution_options(populate_existing=True)
            )
        ).all()
        return [_category(row) for row in rows]

    async def category(
        self, *, slug: str | None = None, category_id: uuid.UUID | None = None
    ) -> CategoryRecord | None:
        query = select(Category)
        query = (
            query.where(Category.slug == slug)
            if slug is not None
            else query.where(Category.id == category_id)
        )
        row = await self._session.scalar(query.execution_options(populate_existing=True))
        return _category(row) if row else None

    async def category_has_children(self, category_id: uuid.UUID) -> bool:
        found = await self._session.scalar(
            select(literal(1))
            .select_from(Category)
            .where(Category.parent_id == category_id)
            .limit(1)
        )
        return found is not None

    async def collections(self, *, include_inactive: bool = False) -> list[CollectionRecord]:
        query = select(Collection).order_by(Collection.title)
        if not include_inactive:
            query = query.where(Collection.is_active.is_(True))
        return [_collection(row) for row in (await self._session.scalars(query)).all()]

    async def collection(
        self,
        *,
        slug: str | None = None,
        collection_id: uuid.UUID | None = None,
        include_inactive: bool = False,
    ) -> CollectionRecord | None:
        query = select(Collection)
        query = (
            query.where(Collection.slug == slug)
            if slug is not None
            else query.where(Collection.id == collection_id)
        )
        if not include_inactive:
            query = query.where(Collection.is_active.is_(True))
        row = await self._session.scalar(query)
        return _collection(row) if row else None

    # ── Writes ────────────────────────────────────────────────────────────

    async def create_product(self, **fields: Any) -> ProductRecord:
        row = Product(**fields)
        self._session.add(row)
        await self._session.flush()
        return _product(row)

    async def update_product(self, product_id: uuid.UUID, **fields: Any) -> ProductRecord:
        row = await self._session.get(Product, product_id)
        if row is None:  # pragma: no cover — the service checks first
            raise LookupError(product_id)
        for key, value in fields.items():
            setattr(row, key, value)
        await self._session.flush()
        await self._session.refresh(row)
        return _product(row)

    async def soft_delete_product(self, product_id: uuid.UUID) -> None:
        await self._session.execute(
            update(Product).where(Product.id == product_id).values(deleted_at=func.now())
        )
        await self._session.execute(
            update(ProductVariant)
            .where(ProductVariant.product_id == product_id, ProductVariant.deleted_at.is_(None))
            .values(deleted_at=func.now())
        )

    async def ensure_option_value(
        self, product_id: uuid.UUID, name: str, value: str, swatch_hex: str | None = None
    ) -> uuid.UUID:
        """The id of ``name = value`` on this product, creating either if missing."""
        option = await self._session.scalar(
            select(ProductOption).where(
                ProductOption.product_id == product_id, ProductOption.name == name
            )
        )
        if option is None:
            position = await self._session.scalar(
                select(func.count())
                .select_from(ProductOption)
                .where(ProductOption.product_id == product_id)
            )
            option = ProductOption(product_id=product_id, name=name, position=int(position or 0))
            self._session.add(option)
            await self._session.flush()
        option_value = await self._session.scalar(
            select(OptionValue).where(
                OptionValue.option_id == option.id, OptionValue.value == value
            )
        )
        if option_value is None:
            position = await self._session.scalar(
                select(func.count())
                .select_from(OptionValue)
                .where(OptionValue.option_id == option.id)
            )
            option_value = OptionValue(
                option_id=option.id, value=value, swatch_hex=swatch_hex, position=int(position or 0)
            )
            self._session.add(option_value)
            await self._session.flush()
        elif swatch_hex is not None and option_value.swatch_hex != swatch_hex:
            option_value.swatch_hex = swatch_hex
        return option_value.id

    async def create_variant(
        self, product_id: uuid.UUID, option_value_ids: list[uuid.UUID], **fields: Any
    ) -> uuid.UUID:
        row = ProductVariant(product_id=product_id, **fields)
        self._session.add(row)
        await self._session.flush()
        for option_value_id in option_value_ids:
            self._session.add(
                VariantOptionValue(variant_id=row.id, option_value_id=option_value_id)
            )
        await self._session.flush()
        return row.id

    async def update_variant(self, variant_id: uuid.UUID, **fields: Any) -> None:
        if fields:
            await self._session.execute(
                update(ProductVariant).where(ProductVariant.id == variant_id).values(**fields)
            )

    async def replace_variant_options(
        self, variant_id: uuid.UUID, option_value_ids: list[uuid.UUID]
    ) -> None:
        await self._session.execute(
            delete(VariantOptionValue).where(VariantOptionValue.variant_id == variant_id)
        )
        for option_value_id in option_value_ids:
            self._session.add(
                VariantOptionValue(variant_id=variant_id, option_value_id=option_value_id)
            )
        await self._session.flush()

    async def soft_delete_variant(self, variant_id: uuid.UUID) -> None:
        await self._session.execute(
            update(ProductVariant)
            .where(ProductVariant.id == variant_id)
            .values(deleted_at=func.now())
        )

    async def variant_matrix_taken(
        self,
        product_id: uuid.UUID,
        option_value_ids: list[uuid.UUID],
        *,
        except_id: uuid.UUID | None,
    ) -> bool:
        """Whether a live variant of this product already has exactly these option values."""
        wanted = sorted(option_value_ids)
        for variant in await self.variants([product_id]):
            if variant.id == except_id:
                continue
            ids = (
                await self._session.scalars(
                    select(VariantOptionValue.option_value_id).where(
                        VariantOptionValue.variant_id == variant.id
                    )
                )
            ).all()
            if sorted(ids) == wanted:
                return True
        return False

    async def prune_unused_option_values(self, product_id: uuid.UUID) -> None:
        """Drop option values no live variant uses, then options left with no values."""
        live_values = (
            select(VariantOptionValue.option_value_id)
            .join(ProductVariant, ProductVariant.id == VariantOptionValue.variant_id)
            .where(ProductVariant.product_id == product_id, ProductVariant.deleted_at.is_(None))
        )
        options = select(ProductOption.id).where(ProductOption.product_id == product_id)
        await self._session.execute(
            delete(OptionValue).where(
                OptionValue.option_id.in_(options), OptionValue.id.not_in(live_values)
            )
        )
        await self._session.execute(
            delete(ProductOption).where(
                ProductOption.product_id == product_id,
                ~exists(select(literal(1)).where(OptionValue.option_id == ProductOption.id)),
            )
        )

    async def create_category(self, **fields: Any) -> CategoryRecord:
        row = Category(**fields)
        self._session.add(row)
        await self._session.flush()
        return _category(row)

    async def update_category(self, category_id: uuid.UUID, **fields: Any) -> CategoryRecord:
        row = await self._session.get(Category, category_id)
        if row is None:  # pragma: no cover
            raise LookupError(category_id)
        for key, value in fields.items():
            setattr(row, key, value)
        await self._session.flush()
        return _category(row)

    async def move_category_subtree(self, old_path: str, new_path: str) -> None:
        """Rewrite the path of a category and every descendant after a move or rename.

        ``subpath(path, n)`` fails when ``n`` is the path's own length, so the
        category itself takes the new path directly; descendants keep their tail.
        """
        old = func.text2ltree(old_path)
        new = func.text2ltree(new_path)
        await self._session.execute(
            update(Category)
            .where(Category.path.op("<@")(old))
            .values(
                path=case(
                    (Category.path == old, new),
                    else_=new.op("||")(func.subpath(Category.path, func.nlevel(old))),
                )
            )
            .execution_options(synchronize_session=False)
        )

    async def delete_category(self, category_id: uuid.UUID) -> None:
        await self._session.execute(delete(Category).where(Category.id == category_id))

    async def create_collection(self, **fields: Any) -> CollectionRecord:
        row = Collection(**fields)
        self._session.add(row)
        await self._session.flush()
        return _collection(row)

    async def update_collection(self, collection_id: uuid.UUID, **fields: Any) -> CollectionRecord:
        row = await self._session.get(Collection, collection_id)
        if row is None:  # pragma: no cover
            raise LookupError(collection_id)
        for key, value in fields.items():
            setattr(row, key, value)
        await self._session.flush()
        return _collection(row)

    async def delete_collection(self, collection_id: uuid.UUID) -> None:
        await self._session.execute(delete(Collection).where(Collection.id == collection_id))

    async def set_collection_products(
        self, collection_id: uuid.UUID, product_ids: list[uuid.UUID]
    ) -> list[uuid.UUID]:
        """Replace the membership. Returns every product whose membership changed."""
        before = set(
            (
                await self._session.scalars(
                    select(ProductCollection.product_id).where(
                        ProductCollection.collection_id == collection_id
                    )
                )
            ).all()
        )
        await self._session.execute(
            delete(ProductCollection).where(ProductCollection.collection_id == collection_id)
        )
        for position, product_id in enumerate(product_ids):
            self._session.add(
                ProductCollection(
                    product_id=product_id, collection_id=collection_id, position=position
                )
            )
        await self._session.flush()
        return sorted(before.symmetric_difference(product_ids), key=str)

    async def collection_product_ids(self, collection_id: uuid.UUID) -> list[uuid.UUID]:
        return list(
            (
                await self._session.scalars(
                    select(ProductCollection.product_id)
                    .where(ProductCollection.collection_id == collection_id)
                    .order_by(ProductCollection.position)
                )
            ).all()
        )

    async def existing_product_ids(self, product_ids: Sequence[uuid.UUID]) -> set[uuid.UUID]:
        if not product_ids:
            return set()
        return set(
            (
                await self._session.scalars(
                    select(Product.id).where(
                        Product.id.in_(product_ids), Product.deleted_at.is_(None)
                    )
                )
            ).all()
        )

    async def product_ids_in_category_tree(self, path: str) -> list[uuid.UUID]:
        descendants = select(Category.id).where(Category.path.op("<@")(func.text2ltree(path)))
        return list(
            (
                await self._session.scalars(
                    select(Product.id).where(Product.category_id.in_(descendants))
                )
            ).all()
        )

    async def add_media(self, **fields: Any) -> MediaRecord:
        if "position" not in fields:
            count = await self._session.scalar(
                select(func.count())
                .select_from(ProductMedia)
                .where(ProductMedia.product_id == fields["product_id"])
            )
            fields["position"] = int(count or 0)
        row = ProductMedia(**fields)
        self._session.add(row)
        await self._session.flush()
        return _media(row)

    async def update_media(self, media_id: uuid.UUID, **fields: Any) -> MediaRecord:
        row = await self._session.get(ProductMedia, media_id)
        if row is None:  # pragma: no cover
            raise LookupError(media_id)
        for key, value in fields.items():
            setattr(row, key, value)
        await self._session.flush()
        return _media(row)

    async def delete_media(self, media_id: uuid.UUID) -> None:
        await self._session.execute(delete(ProductMedia).where(ProductMedia.id == media_id))

    # ── Reviews ───────────────────────────────────────────────────────────

    async def approved_reviews(
        self, product_id: uuid.UUID, *, limit: int, after: tuple[datetime, uuid.UUID] | None
    ) -> tuple[list[ReviewRecord], bool]:
        users = table("users", column("id"), column("first_name"))
        query = (
            select(Review, users.c.first_name)
            .outerjoin(users, users.c.id == Review.user_id)
            .where(Review.product_id == product_id, Review.status == "approved")
        )
        if after is not None:
            query = query.where(
                tuple_(Review.created_at, Review.id) < tuple_(literal(after[0]), literal(after[1]))
            )
        rows = (
            await self._session.execute(
                query.order_by(Review.created_at.desc(), Review.id.desc()).limit(limit + 1)
            )
        ).all()
        return [_review(row[0], row[1]) for row in rows[:limit]], len(rows) > limit

    async def reviews_for_moderation(
        self, *, status: str | None, limit: int, after: tuple[datetime, uuid.UUID] | None
    ) -> tuple[list[ReviewRecord], bool]:
        query = select(Review)
        if status is not None:
            query = query.where(Review.status == status)
        if after is not None:
            query = query.where(
                tuple_(Review.created_at, Review.id) < tuple_(literal(after[0]), literal(after[1]))
            )
        rows = (
            await self._session.scalars(
                query.order_by(Review.created_at.desc(), Review.id.desc()).limit(limit + 1)
            )
        ).all()
        return [_review(row) for row in rows[:limit]], len(rows) > limit

    async def review(self, review_id: uuid.UUID) -> ReviewRecord | None:
        row = await self._session.get(Review, review_id)
        return _review(row) if row else None

    async def user_has_reviewed(self, user_id: uuid.UUID, product_id: uuid.UUID) -> bool:
        found = await self._session.scalar(
            select(literal(1))
            .select_from(Review)
            .where(
                Review.user_id == user_id,
                Review.product_id == product_id,
                Review.status != "rejected",
            )
            .limit(1)
        )
        return found is not None

    async def create_review(self, **fields: Any) -> ReviewRecord:
        row = Review(**fields)
        self._session.add(row)
        await self._session.flush()
        return _review(row)

    async def set_review_status(self, review_id: uuid.UUID, status: str) -> None:
        await self._session.execute(
            update(Review).where(Review.id == review_id).values(status=status)
        )

    async def refresh_rating(self, product_id: uuid.UUID) -> None:
        """Recompute the denormalised average and count from approved reviews."""
        approved = select(
            func.round(func.avg(Review.rating), 2).label("average"),
            func.count(Review.id).label("count"),
        ).where(Review.product_id == product_id, Review.status == "approved")
        row = (await self._session.execute(approved)).one()
        await self._session.execute(
            update(Product)
            .where(Product.id == product_id)
            .values(
                rating_average=row.average,
                rating_count=row.count,
                updated_at=Product.updated_at,  # a review is not an edit of the product
            )
        )

    async def verified_order_for(
        self, user_id: uuid.UUID, product_id: uuid.UUID
    ) -> uuid.UUID | None:
        """The customer's most recent paid order containing this product, if any."""
        orders = table(
            "orders", column("id"), column("user_id"), column("status"), column("placed_at")
        )
        items = table("order_items", column("order_id"), column("variant_id"))
        return await self._session.scalar(
            select(orders.c.id)
            .join(items, items.c.order_id == orders.c.id)
            .join(ProductVariant, ProductVariant.id == items.c.variant_id)
            .where(
                orders.c.user_id == user_id,
                ProductVariant.product_id == product_id,
                orders.c.status.in_(PAID_ORDER_STATUSES),
            )
            .order_by(orders.c.placed_at.desc())
            .limit(1)
        )

    # ── Search support ────────────────────────────────────────────────────

    async def products_by_ids(self, product_ids: Sequence[uuid.UUID]) -> list[ProductRecord]:
        if not product_ids:
            return []
        rows = (
            await self._session.scalars(select(Product).where(Product.id.in_(product_ids)))
        ).all()
        return [_product(row) for row in rows]

    async def live_product_ids(self) -> list[uuid.UUID]:
        return list((await self._session.scalars(select(Product.id).where(live_products()))).all())

    async def option_values_by_product(
        self, product_ids: Sequence[uuid.UUID]
    ) -> dict[uuid.UUID, dict[str, list[str]]]:
        """Values of each option that a live variant actually uses."""
        if not product_ids:
            return {}
        rows = (
            await self._session.execute(
                select(ProductVariant.product_id, ProductOption.name, OptionValue.value)
                .distinct()
                .join(VariantOptionValue, VariantOptionValue.variant_id == ProductVariant.id)
                .join(OptionValue, OptionValue.id == VariantOptionValue.option_value_id)
                .join(ProductOption, ProductOption.id == OptionValue.option_id)
                .where(
                    ProductVariant.product_id.in_(product_ids),
                    ProductVariant.deleted_at.is_(None),
                )
                .order_by(ProductVariant.product_id, ProductOption.name, OptionValue.value)
            )
        ).all()
        result: dict[uuid.UUID, dict[str, list[str]]] = {}
        for product_id, name, value in rows:
            result.setdefault(product_id, {}).setdefault(name, []).append(value)
        return result

    async def matching_ids(self, filters: ListingFilter) -> list[uuid.UUID]:
        """Every live product matching the filters — resolved once, then reused.

        Product-level conditions run first on the products table alone. Only
        when a price or stock filter is present are variants aggregated, and
        then only for the products that survived.
        """
        candidates = list(
            (
                await self._session.scalars(
                    self._product_conditions(
                        select(Product.id).where(live_products()),
                        ListingFilter(
                            category_path=filters.category_path,
                            collection_slug=filters.collection_slug,
                            brands=filters.brands,
                            exclude_id=filters.exclude_id,
                            product_ids=filters.product_ids,
                            options=filters.options,
                            text_query=filters.text_query,
                        ),
                    )
                )
            ).all()
        )
        needs_stats = (
            filters.min_price is not None
            or filters.max_price is not None
            or filters.in_stock is not None
        )
        if not candidates or not needs_stats:
            return candidates
        priced = self._listing(
            ListingFilter(
                product_ids=tuple(candidates),
                min_price=filters.min_price,
                max_price=filters.max_price,
                in_stock=filters.in_stock,
            )
        ).with_only_columns(Product.id)
        return list((await self._session.scalars(priced)).all())

    async def text_search(
        self,
        filters: ListingFilter,
        *,
        sort: SortKey | Literal["relevance"],
        limit: int,
        offset: int,
        ids: list[uuid.UUID] | None = None,
    ) -> tuple[list[ProductSummary], int]:
        """The degraded path when Meilisearch is down: Postgres full-text, offset paged."""
        if ids is None:
            ids = await self.matching_ids(filters)
        if not ids:
            return [], 0
        if sort == "relevance":
            order: tuple[Any, ...] = (
                (_text_rank(filters.text_query).desc(), Product.published_at.desc(), Product.id)
                if filters.text_query
                else (Product.published_at.desc(), Product.id)
            )
            page_ids = list(
                (
                    await self._session.scalars(
                        select(Product.id)
                        .where(among(Product.id, ids))
                        .order_by(*order)
                        .limit(limit)
                        .offset(offset)
                    )
                ).all()
            )
            return await self.summaries(page_ids), len(ids)
        query = self._listing(ListingFilter(product_ids=tuple(ids)))
        sort_column, ascending = self._sort_column(query, sort)
        id_column = query.selected_columns.id
        rows = (
            await self._session.execute(
                query.order_by(sort_column.asc() if ascending else sort_column.desc(), id_column)
                .limit(limit)
                .offset(offset)
            )
        ).all()
        images = await self._primary_images([row.id for row in rows])
        return [self._summary(row, images.get(row.id)) for row in rows], len(ids)

    async def facet_counts(
        self,
        filters: ListingFilter,
        option_names: Sequence[str],
        ids: list[uuid.UUID] | None = None,
    ) -> dict[str, dict[str, int]]:
        """Counts per brand, category and option value over the matching products."""
        if ids is None:
            ids = await self.matching_ids(filters)
        facets: dict[str, dict[str, int]] = {"brand": {}, "category": {}}
        facets.update({name.lower(): {} for name in option_names})
        if not ids:
            return facets
        brand_rows = (
            await self._session.execute(
                select(Product.brand, func.count())
                .where(among(Product.id, ids), Product.brand.is_not(None))
                .group_by(Product.brand)
            )
        ).all()
        facets["brand"] = {str(brand): int(count) for brand, count in brand_rows}
        category_rows = (
            await self._session.execute(
                select(Category.slug, func.count())
                .join(Product, Product.category_id == Category.id)
                .where(among(Product.id, ids))
                .group_by(Category.slug)
            )
        ).all()
        facets["category"] = {str(slug): int(count) for slug, count in category_rows}
        option_rows = (
            await self._session.execute(
                select(
                    func.lower(ProductOption.name),
                    OptionValue.value,
                    func.count(func.distinct(ProductVariant.product_id)),
                )
                .join(VariantOptionValue, VariantOptionValue.option_value_id == OptionValue.id)
                .join(ProductVariant, ProductVariant.id == VariantOptionValue.variant_id)
                .join(ProductOption, ProductOption.id == OptionValue.option_id)
                .where(
                    among(ProductVariant.product_id, ids),
                    ProductVariant.deleted_at.is_(None),
                    func.lower(ProductOption.name).in_([name.lower() for name in option_names]),
                )
                .group_by(func.lower(ProductOption.name), OptionValue.value)
            )
        ).all()
        for name, value, count in option_rows:
            facets[str(name)][str(value)] = int(count)
        return facets

    async def title_suggestions(self, prefix: str, limit: int) -> list[tuple[str, str]]:
        """(title, slug) of live products with a title word starting with ``prefix``."""
        escaped = _escape_like(prefix)
        rows = (
            await self._session.execute(
                select(Product.title, Product.slug)
                .where(
                    live_products(),
                    or_(
                        Product.title.ilike(f"{escaped}%", escape="\\"),
                        Product.title.ilike(f"% {escaped}%", escape="\\"),
                    ),
                )
                .order_by(func.coalesce(Product.rating_average, 0).desc(), Product.title)
                .limit(limit)
            )
        ).all()
        return [(row.title, row.slug) for row in rows]

    # ── Admin ─────────────────────────────────────────────────────────────

    async def admin_products(
        self,
        *,
        status: str | None,
        query_text: str | None,
        limit: int,
        after: tuple[datetime, uuid.UUID] | None,
    ) -> tuple[list[ProductRecord], bool, int]:
        """Every product not deleted, drafts included, most recently edited first."""
        query = select(Product).where(Product.deleted_at.is_(None))
        if status is not None:
            query = query.where(Product.status == status)
        if query_text:
            pattern = f"%{_escape_like(query_text)}%"
            query = query.where(
                or_(
                    Product.title.ilike(pattern, escape="\\"),
                    Product.slug.ilike(pattern, escape="\\"),
                    Product.id.in_(
                        select(ProductVariant.product_id).where(
                            ProductVariant.sku.ilike(pattern, escape="\\")
                        )
                    ),
                )
            )
        total = int(
            await self._session.scalar(select(func.count()).select_from(query.subquery())) or 0
        )
        if after is not None:
            query = query.where(
                tuple_(Product.updated_at, Product.id)
                < tuple_(literal(after[0]), literal(after[1]))
            )
        rows = (
            await self._session.scalars(
                query.order_by(Product.updated_at.desc(), Product.id.desc()).limit(limit + 1)
            )
        ).all()
        return [_product(row) for row in rows[:limit]], len(rows) > limit, total

    async def price_and_stock(
        self, product_ids: Sequence[uuid.UUID]
    ) -> dict[uuid.UUID, tuple[int, str, bool]]:
        """(lowest price, currency, in stock) for products that have variants."""
        if not product_ids:
            return {}
        rows = (
            await self._session.execute(
                self._listing(ListingFilter(product_ids=tuple(product_ids)), include_hidden=True)
            )
        ).all()
        return {row.id: (row.price_min, row.currency, bool(row.in_stock)) for row in rows}

    async def primary_images(self, product_ids: list[uuid.UUID]) -> dict[uuid.UUID, MediaRecord]:
        return await self._primary_images(product_ids)

    async def all_products_for_export(
        self, *, limit: int, after: uuid.UUID | None
    ) -> list[ProductRecord]:
        query = select(Product).where(Product.deleted_at.is_(None))
        if after is not None:
            query = query.where(Product.id > after)
        rows = (await self._session.scalars(query.order_by(Product.id).limit(limit))).all()
        return [_product(row) for row in rows]

    async def product_by_slug_any(self, slug: str) -> ProductRecord | None:
        """Including drafts and archived; not deleted. For imports and admin lookups."""
        row = await self._session.scalar(
            select(Product).where(Product.slug == slug, Product.deleted_at.is_(None))
        )
        return _product(row) if row else None

    async def variant_by_sku(self, sku: str) -> VariantRecord | None:
        row = await self._session.scalar(
            select(ProductVariant).where(
                ProductVariant.sku == sku, ProductVariant.deleted_at.is_(None)
            )
        )
        if row is None:
            return None
        option_values = await self._variant_option_values([row.id])
        return self._variant(row, option_values.get(row.id, {}))

    async def set_product_collections(self, product_id: uuid.UUID, slugs: Sequence[str]) -> None:
        collections = (
            await self._session.scalars(select(Collection).where(Collection.slug.in_(slugs)))
        ).all()
        await self._session.execute(
            delete(ProductCollection).where(ProductCollection.product_id == product_id)
        )
        for collection in collections:
            self._session.add(ProductCollection(product_id=product_id, collection_id=collection.id))
        await self._session.flush()

    async def collection_slugs_known(self, slugs: Sequence[str]) -> set[str]:
        if not slugs:
            return set()
        return set(
            (
                await self._session.scalars(
                    select(Collection.slug).where(Collection.slug.in_(slugs))
                )
            ).all()
        )
