"""Catalog administration: products, variants, categories, collections, media, reviews.

Every mutation, in one transaction:

1. validate against the catalog's rules,
2. write,
3. append to the audit log (who, what, which fields changed),
4. record an outbox event, which the worker turns into a search-index update,
   cache invalidation, or image processing (ADR-009),

then commit, clear the cache entries an editor would otherwise see stale, and
kick the worker.
"""

from __future__ import annotations

import re
import unicodedata
import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from velo.core.errors import FieldError, NotFoundError
from velo.core.jobs import JobQueue, NullJobQueue
from velo.core.pagination import CursorPage, MoneyJson, PaginationInfo, decode_cursor, encode_cursor
from velo.core.storage import MediaStorage
from velo.db.ids import uuid7
from velo.domains.catalog.cache import CatalogCache
from velo.domains.catalog.exceptions import (
    CatalogRuleError,
    DuplicateVariantError,
    InvalidMediaError,
    NotPublishableError,
    SkuTakenError,
    SlugTakenError,
)
from velo.domains.catalog.repository import (
    CatalogRepository,
    CategoryRecord,
    CollectionRecord,
    MediaRecord,
    ProductRecord,
    VariantRecord,
)
from velo.domains.catalog.schemas import (
    AdminCategoryView,
    AdminCollectionView,
    AdminProductRow,
    AdminProductView,
    AdminVariantView,
    CategoryCreate,
    CategoryUpdate,
    CollectionCreate,
    CollectionUpdate,
    MediaAttach,
    MediaUpdate,
    PresignRequest,
    PresignResponse,
    ProductCreate,
    ProductUpdate,
    StockView,
    VariantInput,
    VariantUpdate,
)
from velo.domains.catalog.views import MediaView, OptionValueView, OptionView
from velo.domains.inventory.service import InventoryService
from velo.domains.platform.events import Actor, diff, record_audit, record_event

_EXTENSIONS = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif"}
_PRODUCT_FIELDS = (
    "title",
    "slug",
    "subtitle",
    "description",
    "brand",
    "status",
    "category_id",
    "seo_title",
    "seo_description",
    "attributes",
)


def slugify(value: str) -> str:
    """'Merino Crew — Navy' → 'merino-crew-navy'."""
    ascii_text = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()).strip("-")[:100] or "item"


class CatalogAdminService:
    def __init__(
        self,
        session: AsyncSession,
        *,
        cache: CatalogCache,
        inventory: InventoryService,
        jobs: JobQueue | None = None,
        storage: MediaStorage | None = None,
    ) -> None:
        self._session = session
        self._catalog = CatalogRepository(session)
        self._cache = cache
        self._inventory = inventory
        self._jobs = jobs or NullJobQueue()
        self._storage = storage

    # ── Shared plumbing ───────────────────────────────────────────────────

    async def _commit(self, *slugs: str) -> None:
        await self._session.commit()
        await self._cache.invalidate_product(*slugs)
        await self._cache.bump()
        await self._jobs.kick_outbox()

    def _event(self, product_id: uuid.UUID, event_type: str, **payload: Any) -> None:
        record_event(self._session, "product", product_id, event_type, payload)

    async def _unique_slug(self, wanted: str, *, except_id: uuid.UUID | None = None) -> str:
        candidate, n = wanted, 2
        while await self._catalog.slug_taken(candidate, except_id=except_id):
            candidate = f"{wanted}-{n}"
            n += 1
        return candidate

    async def _category_id(self, slug: str | None) -> uuid.UUID | None:
        if slug is None:
            return None
        category = await self._catalog.category(slug=slug)
        if category is None:
            raise CatalogRuleError(
                f"No category “{slug}”.",
                errors=[FieldError(field="category", code="unknown", message="No such category.")],
            )
        return category.id

    async def _require_product(self, product_id: uuid.UUID) -> ProductRecord:
        product = await self._catalog.product_by_id(product_id)
        if product is None:
            raise NotFoundError("No such product.")
        return product

    async def _require_variant(self, variant_id: uuid.UUID) -> VariantRecord:
        variant = await self._catalog.variant(variant_id)
        if variant is None:
            raise NotFoundError("No such variant.")
        return variant

    # ── Products ──────────────────────────────────────────────────────────

    async def list_products(
        self,
        *,
        status: str | None = None,
        query_text: str | None = None,
        limit: int = 50,
        cursor: str | None = None,
    ) -> CursorPage[AdminProductRow]:
        after = decode_cursor(cursor, "admin-products") if cursor else None
        products, has_more, total = await self._catalog.admin_products(
            status=status, query_text=query_text, limit=limit, after=after
        )
        ids = [product.id for product in products]
        prices = await self._catalog.price_and_stock(ids)
        images = await self._catalog.primary_images(ids)
        rows = []
        for product in products:
            price = prices.get(product.id)
            image = images.get(product.id)
            rows.append(
                AdminProductRow(
                    id=product.id,
                    slug=product.slug,
                    title=product.title,
                    status=product.status,
                    brand=product.brand,
                    price=MoneyJson(amount=price[0], currency=price[1]) if price else None,
                    in_stock=price[2] if price else False,
                    updated_at=product.updated_at,
                    image=MediaView.of(image) if image else None,
                )
            )
        next_cursor = (
            encode_cursor("admin-products", products[-1].updated_at, products[-1].id)
            if has_more and products
            else None
        )
        return CursorPage[AdminProductRow](
            data=rows,
            pagination=PaginationInfo(
                next_cursor=next_cursor, has_more=has_more, limit=limit, total_count=total
            ),
        )

    async def get_product(self, product_id: uuid.UUID) -> AdminProductView:
        return await self._view(await self._require_product(product_id))

    async def _view(self, product: ProductRecord) -> AdminProductView:
        options = await self._catalog.options(product.id)
        variants = await self._catalog.variants([product.id])
        media = await self._catalog.media(product.id)
        collections = await self._catalog.collection_slugs([product.id])
        category = (
            await self._catalog.category(category_id=product.category_id)
            if product.category_id
            else None
        )
        found = await self._inventory.stocks([variant.id for variant in variants])
        stock: dict[uuid.UUID, Any] = {variant.id: found.get(variant.id) for variant in variants}
        return AdminProductView(
            id=product.id,
            slug=product.slug,
            title=product.title,
            subtitle=product.subtitle,
            description=product.description,
            brand=product.brand,
            status=product.status,
            category=category.slug if category else None,
            seo_title=product.seo_title,
            seo_description=product.seo_description,
            attributes=product.attributes,
            rating_average=float(product.rating_average) if product.rating_average else None,
            rating_count=product.rating_count,
            published_at=product.published_at,
            created_at=product.created_at,
            updated_at=product.updated_at,
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
            variants=[self._variant_view(variant, stock.get(variant.id)) for variant in variants],
            media=[MediaView.of(item) for item in media],
            collections=collections.get(product.id, []),
        )

    @staticmethod
    def _variant_view(variant: VariantRecord, stock: Any) -> AdminVariantView:
        currency = variant.price_currency
        return AdminVariantView(
            id=variant.id,
            sku=variant.sku,
            title=variant.title,
            price=MoneyJson(amount=variant.price_amount, currency=currency),
            compare_at=(
                MoneyJson(amount=variant.compare_at_amount, currency=currency)
                if variant.compare_at_amount is not None
                else None
            ),
            cost=(
                MoneyJson(amount=variant.cost_amount, currency=currency)
                if variant.cost_amount is not None
                else None
            ),
            weight_grams=variant.weight_grams,
            barcode=variant.barcode,
            requires_shipping=variant.requires_shipping,
            is_taxable=variant.is_taxable,
            position=variant.position,
            option_values=variant.option_values,
            stock=(
                StockView(
                    quantity_on_hand=stock.quantity_on_hand,
                    quantity_reserved=stock.quantity_reserved,
                    available=stock.available,
                    reorder_point=stock.reorder_point,
                    track_inventory=stock.track_inventory,
                    allow_backorder=stock.allow_backorder,
                )
                if stock
                else None
            ),
        )

    async def create_product(self, body: ProductCreate, actor: Actor) -> AdminProductView:
        slug = body.slug or await self._unique_slug(slugify(body.title))
        if body.slug and await self._catalog.slug_taken(body.slug):
            raise SlugTakenError(body.slug)
        if body.status == "active" and not body.variants:
            raise NotPublishableError("Add at least one variant before publishing.")
        await self._check_collections(body.collections)

        product = await self._catalog.create_product(
            slug=slug,
            title=body.title,
            subtitle=body.subtitle,
            description=body.description,
            brand=body.brand,
            status=body.status,
            category_id=await self._category_id(body.category),
            seo_title=body.seo_title,
            seo_description=body.seo_description,
            attributes=body.attributes,
            published_at=datetime.now(UTC) if body.status == "active" else None,
        )
        for position, variant in enumerate(body.variants):
            await self._add_variant(product.id, variant, position, actor)
        if body.collections:
            await self._catalog.set_product_collections(product.id, body.collections)
        record_audit(
            self._session,
            actor,
            "product.created",
            "product",
            product.id,
            {"slug": slug, "title": body.title, "status": body.status},
        )
        self._event(product.id, "product.created", slug=slug)
        await self._commit(slug)
        return await self.get_product(product.id)

    async def update_product(
        self, product_id: uuid.UUID, body: ProductUpdate, actor: Actor
    ) -> AdminProductView:
        before = await self._require_product(product_id)
        changes: dict[str, Any] = body.model_dump(
            exclude_unset=True, exclude={"category", "collections"}
        )
        if "category" in body.model_fields_set:
            changes["category_id"] = await self._category_id(body.category)
        for required in ("title", "slug", "status", "attributes"):
            if changes.get(required, "") is None:
                changes.pop(required)
        if (
            "slug" in changes
            and changes["slug"] != before.slug
            and await self._catalog.slug_taken(changes["slug"], except_id=product_id)
        ):
            raise SlugTakenError(changes["slug"])
        status = changes.get("status", before.status)
        if status == "active":
            if not await self._catalog.variants([product_id]):
                raise NotPublishableError("Add at least one variant before publishing.")
            if before.published_at is None:
                changes["published_at"] = datetime.now(UTC)

        if body.collections is not None:
            await self._check_collections(body.collections)
            old = (await self._catalog.collection_slugs([product_id])).get(product_id, [])
            if sorted(old) != sorted(body.collections):
                await self._catalog.set_product_collections(product_id, body.collections)
                changes_for_audit = {"collections": {"from": old, "to": body.collections}}
            else:
                changes_for_audit = {}
        else:
            changes_for_audit = {}

        after = await self._catalog.update_product(product_id, **changes) if changes else before
        audit = (
            diff(
                {key: getattr(before, key) for key in changes if key in _PRODUCT_FIELDS},
                {key: getattr(after, key) for key in changes if key in _PRODUCT_FIELDS},
            )
            | changes_for_audit
        )
        if audit:
            record_audit(self._session, actor, "product.updated", "product", product_id, audit)
            self._event(product_id, "product.updated", slug=after.slug, old_slug=before.slug)
            await self._commit(after.slug, before.slug)
        return await self.get_product(product_id)

    async def delete_product(self, product_id: uuid.UUID, actor: Actor) -> None:
        """Soft delete: sold products stay resolvable for order history (DATA-MODEL.md §4)."""
        product = await self._require_product(product_id)
        await self._catalog.soft_delete_product(product_id)
        record_audit(
            self._session, actor, "product.deleted", "product", product_id, {"slug": product.slug}
        )
        self._event(product_id, "product.deleted", slug=product.slug)
        await self._commit(product.slug)

    async def _check_collections(self, slugs: Sequence[str]) -> None:
        unknown = sorted(set(slugs) - await self._catalog.collection_slugs_known(slugs))
        if unknown:
            raise CatalogRuleError(
                f"No collection: {', '.join(unknown)}.",
                errors=[
                    FieldError(field="collections", code="unknown", message="No such collection.")
                ],
            )

    # ── Variants ──────────────────────────────────────────────────────────

    async def _option_value_ids(
        self, product_id: uuid.UUID, options: dict[str, str], swatches: dict[str, str]
    ) -> list[uuid.UUID]:
        return [
            await self._catalog.ensure_option_value(product_id, name, value, swatches.get(value))
            for name, value in options.items()
        ]

    async def _add_variant(
        self, product_id: uuid.UUID, body: VariantInput, position: int, actor: Actor
    ) -> uuid.UUID:
        if await self._catalog.sku_taken(body.sku):
            raise SkuTakenError(body.sku)
        if body.compare_at is not None and body.compare_at <= body.price:
            raise CatalogRuleError(
                "A compare-at price must be higher than the price.",
                errors=[
                    FieldError(field="compare_at", code="too_low", message="Must exceed the price.")
                ],
            )
        option_value_ids = await self._option_value_ids(product_id, body.options, body.swatches)
        if await self._catalog.variant_matrix_taken(product_id, option_value_ids, except_id=None):
            combination = ", ".join(f"{k} {v}" for k, v in body.options.items())
            raise DuplicateVariantError(f"A variant with {combination or 'no options'} exists.")
        variant_id = await self._catalog.create_variant(
            product_id,
            option_value_ids,
            sku=body.sku,
            title=body.title or (" / ".join(body.options.values()) or "Default"),
            price_amount=body.price,
            price_currency=body.currency,
            compare_at_amount=body.compare_at,
            cost_amount=body.cost,
            weight_grams=body.weight_grams,
            barcode=body.barcode,
            requires_shipping=body.requires_shipping,
            is_taxable=body.is_taxable,
            position=position,
        )
        await self._inventory.open_stock(
            variant_id,
            quantity=body.stock,
            reorder_point=body.reorder_point,
            track_inventory=body.track_inventory,
            allow_backorder=body.allow_backorder,
            actor=actor,
        )
        return variant_id

    async def add_variant(
        self, product_id: uuid.UUID, body: VariantInput, actor: Actor
    ) -> AdminProductView:
        product = await self._require_product(product_id)
        position = len(await self._catalog.variants([product_id]))
        variant_id = await self._add_variant(product_id, body, position, actor)
        record_audit(
            self._session,
            actor,
            "variant.created",
            "product_variant",
            variant_id,
            {"sku": body.sku},
        )
        self._event(product_id, "product.updated", slug=product.slug)
        await self._commit(product.slug)
        return await self.get_product(product_id)

    async def update_variant(
        self, variant_id: uuid.UUID, body: VariantUpdate, actor: Actor
    ) -> AdminProductView:
        before = await self._require_variant(variant_id)
        product = await self._require_product(before.product_id)
        fields = body.model_dump(exclude_unset=True, exclude={"options", "swatches"})
        columns: dict[str, Any] = {}
        mapping = {
            "price": "price_amount",
            "compare_at": "compare_at_amount",
            "cost": "cost_amount",
        }
        for key, value in fields.items():
            if value is None and key in (
                "sku",
                "price",
                "title",
                "requires_shipping",
                "is_taxable",
            ):
                continue  # required columns cannot be cleared
            columns[mapping.get(key, key)] = value
        if (
            "sku" in columns
            and columns["sku"] != before.sku
            and await self._catalog.sku_taken(columns["sku"], except_id=variant_id)
        ):
            raise SkuTakenError(columns["sku"])
        price = columns.get("price_amount", before.price_amount)
        compare_at = columns.get("compare_at_amount", before.compare_at_amount)
        if compare_at is not None and compare_at <= price:
            raise CatalogRuleError(
                "A compare-at price must be higher than the price.",
                errors=[
                    FieldError(field="compare_at", code="too_low", message="Must exceed the price.")
                ],
            )
        if body.options is not None:
            option_value_ids = await self._option_value_ids(product.id, body.options, body.swatches)
            if await self._catalog.variant_matrix_taken(
                product.id, option_value_ids, except_id=variant_id
            ):
                raise DuplicateVariantError("Another variant already has those options.")
            await self._catalog.replace_variant_options(variant_id, option_value_ids)
            await self._catalog.prune_unused_option_values(product.id)
            if "title" not in columns:
                columns["title"] = " / ".join(body.options.values()) or "Default"
        await self._catalog.update_variant(variant_id, **columns)
        after = await self._require_variant(variant_id)
        audit = diff(
            {
                **before.option_values,
                "sku": before.sku,
                "price": before.price_amount,
                "compare_at": before.compare_at_amount,
                "title": before.title,
            },
            {
                **after.option_values,
                "sku": after.sku,
                "price": after.price_amount,
                "compare_at": after.compare_at_amount,
                "title": after.title,
            },
        )
        if audit:
            record_audit(
                self._session, actor, "variant.updated", "product_variant", variant_id, audit
            )
            self._event(product.id, "product.updated", slug=product.slug)
            await self._commit(product.slug)
        return await self.get_product(product.id)

    async def delete_variant(self, variant_id: uuid.UUID, actor: Actor) -> AdminProductView:
        variant = await self._require_variant(variant_id)
        product = await self._require_product(variant.product_id)
        remaining = [v for v in await self._catalog.variants([product.id]) if v.id != variant_id]
        if not remaining and product.status == "active":
            raise NotPublishableError(
                "A live product needs at least one variant. Unpublish it first."
            )
        await self._catalog.soft_delete_variant(variant_id)
        await self._catalog.prune_unused_option_values(product.id)
        record_audit(
            self._session,
            actor,
            "variant.deleted",
            "product_variant",
            variant_id,
            {"sku": variant.sku},
        )
        self._event(product.id, "product.updated", slug=product.slug)
        await self._commit(product.slug)
        return await self.get_product(product.id)

    # ── Categories ────────────────────────────────────────────────────────

    @staticmethod
    def _category_view(category: CategoryRecord) -> AdminCategoryView:
        return AdminCategoryView(
            id=category.id,
            slug=category.slug,
            name=category.name,
            parent_id=category.parent_id,
            path=category.path,
            position=category.position,
        )

    async def list_categories(self) -> list[AdminCategoryView]:
        return [self._category_view(item) for item in await self._catalog.categories()]

    async def _require_category(self, category_id: uuid.UUID) -> CategoryRecord:
        category = await self._catalog.category(category_id=category_id)
        if category is None:
            raise NotFoundError("No such category.")
        return category

    async def _category_slug_free(self, slug: str, except_id: uuid.UUID | None = None) -> None:
        existing = await self._catalog.category(slug=slug)
        if existing is not None and existing.id != except_id:
            raise SlugTakenError(slug)

    async def create_category(self, body: CategoryCreate, actor: Actor) -> AdminCategoryView:
        slug = body.slug or slugify(body.name)
        await self._category_slug_free(slug)
        parent = await self._catalog.category(slug=body.parent) if body.parent else None
        if body.parent and parent is None:
            raise CatalogRuleError(f"No parent category “{body.parent}”.")
        path = f"{parent.path}.{slug}" if parent else slug
        category = await self._catalog.create_category(
            slug=slug,
            name=body.name,
            parent_id=parent.id if parent else None,
            path=path,
            position=body.position,
        )
        record_audit(
            self._session, actor, "category.created", "category", category.id, {"slug": slug}
        )
        await self._commit()
        return self._category_view(category)

    async def update_category(
        self, category_id: uuid.UUID, body: CategoryUpdate, actor: Actor
    ) -> AdminCategoryView:
        before = await self._require_category(category_id)
        fields: dict[str, Any] = {}
        if body.name is not None:
            fields["name"] = body.name
        if body.position is not None:
            fields["position"] = body.position
        slug = body.slug or before.slug
        if slug != before.slug:
            await self._category_slug_free(slug, except_id=category_id)
            fields["slug"] = slug

        parent_path = before.path.rsplit(".", 1)[0] if "." in before.path else None
        parent_id = before.parent_id
        if body.move_to_root:
            parent_path, parent_id = None, None
        elif body.parent is not None:
            parent = await self._catalog.category(slug=body.parent)
            if parent is None:
                raise CatalogRuleError(f"No parent category “{body.parent}”.")
            if parent.path == before.path or parent.path.startswith(before.path + "."):
                raise CatalogRuleError("A category cannot be moved inside itself.")
            parent_path, parent_id = parent.path, parent.id
        new_path = f"{parent_path}.{slug}" if parent_path else slug
        if parent_id != before.parent_id:
            fields["parent_id"] = parent_id

        if new_path != before.path:
            await self._catalog.move_category_subtree(before.path, new_path)
        if fields:
            await self._catalog.update_category(category_id, **fields)
        after = await self._require_category(category_id)
        audit = diff(
            {
                "slug": before.slug,
                "name": before.name,
                "path": before.path,
                "position": before.position,
            },
            {
                "slug": after.slug,
                "name": after.name,
                "path": after.path,
                "position": after.position,
            },
        )
        if audit:
            record_audit(self._session, actor, "category.updated", "category", category_id, audit)
            # Every product in the subtree carries the category in its search document.
            for product_id in await self._catalog.product_ids_in_category_tree(after.path):
                self._event(product_id, "product.updated")
            await self._commit()
        return self._category_view(after)

    async def delete_category(self, category_id: uuid.UUID, actor: Actor) -> None:
        category = await self._require_category(category_id)
        if await self._catalog.category_has_children(category_id):
            raise CatalogRuleError("Move or delete this category's subcategories first.")
        affected = await self._catalog.product_ids_in_category_tree(category.path)
        await self._catalog.delete_category(category_id)  # products keep existing, uncategorised
        record_audit(
            self._session,
            actor,
            "category.deleted",
            "category",
            category_id,
            {"slug": category.slug},
        )
        for product_id in affected:
            self._event(product_id, "product.updated")
        await self._commit()

    # ── Collections ───────────────────────────────────────────────────────

    async def _collection_view(self, collection: CollectionRecord) -> AdminCollectionView:
        return AdminCollectionView(
            id=collection.id,
            slug=collection.slug,
            title=collection.title,
            description=collection.description,
            is_active=collection.is_active,
            products=await self._catalog.collection_product_ids(collection.id),
        )

    async def list_collections(self) -> list[AdminCollectionView]:
        return [
            await self._collection_view(item)
            for item in await self._catalog.collections(include_inactive=True)
        ]

    async def _require_collection(self, collection_id: uuid.UUID) -> CollectionRecord:
        collection = await self._catalog.collection(
            collection_id=collection_id, include_inactive=True
        )
        if collection is None:
            raise NotFoundError("No such collection.")
        return collection

    async def _set_members(self, collection_id: uuid.UUID, product_ids: list[uuid.UUID]) -> None:
        unique = list(dict.fromkeys(product_ids))
        missing = set(unique) - await self._catalog.existing_product_ids(unique)
        if missing:
            raise CatalogRuleError(f"{len(missing)} of those products do not exist.")
        for product_id in await self._catalog.set_collection_products(collection_id, unique):
            self._event(product_id, "product.updated")

    async def create_collection(self, body: CollectionCreate, actor: Actor) -> AdminCollectionView:
        slug = body.slug or slugify(body.title)
        if await self._catalog.collection(slug=slug, include_inactive=True):
            raise SlugTakenError(slug)
        collection = await self._catalog.create_collection(
            slug=slug, title=body.title, description=body.description, is_active=body.is_active
        )
        await self._set_members(collection.id, body.products)
        record_audit(
            self._session, actor, "collection.created", "collection", collection.id, {"slug": slug}
        )
        await self._commit()
        return await self._collection_view(collection)

    async def update_collection(
        self, collection_id: uuid.UUID, body: CollectionUpdate, actor: Actor
    ) -> AdminCollectionView:
        before = await self._require_collection(collection_id)
        fields = body.model_dump(exclude_unset=True, exclude={"products"})
        for required in ("title", "slug", "is_active"):
            if fields.get(required, "") is None:
                fields.pop(required)
        if "slug" in fields and fields["slug"] != before.slug:
            existing = await self._catalog.collection(slug=fields["slug"], include_inactive=True)
            if existing is not None:
                raise SlugTakenError(fields["slug"])
        after = await self._catalog.update_collection(collection_id, **fields) if fields else before
        if body.products is not None:
            await self._set_members(collection_id, body.products)
        if fields.get("slug") or "is_active" in fields:
            # The slug or visibility is in every member's search document.
            for product_id in await self._catalog.collection_product_ids(collection_id):
                self._event(product_id, "product.updated")
        record_audit(
            self._session,
            actor,
            "collection.updated",
            "collection",
            collection_id,
            diff(
                {key: getattr(before, key) for key in fields},
                {key: getattr(after, key) for key in fields},
            )
            | ({"products": "replaced"} if body.products is not None else {}),
        )
        await self._commit()
        return await self._collection_view(after)

    async def delete_collection(self, collection_id: uuid.UUID, actor: Actor) -> None:
        collection = await self._require_collection(collection_id)
        members = await self._catalog.collection_product_ids(collection_id)
        await self._catalog.delete_collection(collection_id)
        record_audit(
            self._session,
            actor,
            "collection.deleted",
            "collection",
            collection_id,
            {"slug": collection.slug},
        )
        for product_id in members:
            self._event(product_id, "product.updated")
        await self._commit()

    # ── Media ─────────────────────────────────────────────────────────────

    def _require_storage(self) -> MediaStorage:
        if self._storage is None:  # pragma: no cover — configured in every environment
            raise InvalidMediaError("Media storage is not configured.")
        return self._storage

    async def presign(self, body: PresignRequest) -> PresignResponse:
        storage = self._require_storage()
        await self._require_product(body.product_id)
        # Keys are unguessable and never reused: a replaced image gets a new URL,
        # so CDN caches never serve a stale one.
        key = f"products/{body.product_id}/{uuid7()}/original.{_EXTENSIONS[body.content_type]}"
        upload = storage.presign_upload(key, body.content_type)
        return PresignResponse(
            url=upload.url,
            fields=upload.fields,
            key=upload.key,
            expires_in=upload.expires_in,
            max_bytes=upload.max_bytes,
        )

    async def attach_media(
        self, product_id: uuid.UUID, body: MediaAttach, actor: Actor
    ) -> MediaView:
        storage = self._require_storage()
        product = await self._require_product(product_id)
        if not body.key.startswith(f"products/{product_id}/"):
            raise InvalidMediaError("That upload belongs to another product.")
        if not await storage.exists(body.key):
            raise InvalidMediaError("The upload has not arrived. Upload the file, then attach it.")
        if body.variant_id is not None:
            variant = await self._catalog.variant(body.variant_id)
            if variant is None or variant.product_id != product_id:
                raise InvalidMediaError("That variant is not part of this product.")
        media = await self._catalog.add_media(
            product_id=product_id,
            variant_id=body.variant_id,
            url=storage.public_url(body.key),
            alt_text=body.alt_text,
        )
        record_audit(
            self._session, actor, "media.added", "product_media", media.id, {"key": body.key}
        )
        record_event(self._session, "media", media.id, "media.uploaded", {"key": body.key})
        self._event(product_id, "product.updated", slug=product.slug)
        await self._commit(product.slug)
        return MediaView.of(media)

    async def _require_media(self, media_id: uuid.UUID) -> tuple[MediaRecord, ProductRecord]:
        media = await self._catalog.media_item(media_id)
        if media is None:
            raise NotFoundError("No such media.")
        return media, await self._require_product(media.product_id)

    async def update_media(self, media_id: uuid.UUID, body: MediaUpdate, actor: Actor) -> MediaView:
        before, product = await self._require_media(media_id)
        fields: dict[str, Any] = {}
        if body.alt_text is not None:
            fields["alt_text"] = body.alt_text
        if body.position is not None:
            fields["position"] = body.position
        if body.detach_variant:
            fields["variant_id"] = None
        elif body.variant_id is not None:
            variant = await self._catalog.variant(body.variant_id)
            if variant is None or variant.product_id != product.id:
                raise InvalidMediaError("That variant is not part of this product.")
            fields["variant_id"] = body.variant_id
        if not fields:
            return MediaView.of(before)
        after = await self._catalog.update_media(media_id, **fields)
        record_audit(
            self._session,
            actor,
            "media.updated",
            "product_media",
            media_id,
            diff({key: getattr(before, key) for key in fields}, fields),
        )
        self._event(product.id, "product.updated", slug=product.slug)
        await self._commit(product.slug)
        return MediaView.of(after)

    async def delete_media(self, media_id: uuid.UUID, actor: Actor) -> None:
        media, product = await self._require_media(media_id)
        await self._catalog.delete_media(media_id)
        record_audit(
            self._session, actor, "media.deleted", "product_media", media_id, {"url": media.url}
        )
        key = self._storage.key_from_url(media.url) if self._storage else None
        if key is not None:
            # The folder holds the original and every rendition; the worker removes it.
            record_event(
                self._session,
                "media",
                media_id,
                "media.deleted",
                {"prefix": key.rsplit("/", 1)[0] + "/"},
            )
        self._event(product.id, "product.updated", slug=product.slug)
        await self._commit(product.slug)
