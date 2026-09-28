"""What the storefront receives from the catalog — API-SPEC.md §2, "Catalog".

Plain Pydantic, no HTTP: the service builds these, the cache stores them as
JSON, and the router returns them unchanged.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel

from velo.core.pagination import CursorPage, MoneyJson
from velo.domains.catalog.repository import MediaRecord, ProductSummary


class RenditionView(BaseModel):
    width: int
    height: int
    format: str  # "avif" | "webp"
    url: str


class MediaView(BaseModel):
    id: uuid.UUID
    url: str
    alt_text: str | None
    width: int | None
    height: int | None
    blurhash: str | None
    media_type: str
    variant_id: uuid.UUID | None
    # For srcset. Empty until the worker has processed the upload.
    renditions: list[RenditionView] = []

    @classmethod
    def of(cls, media: MediaRecord) -> MediaView:
        return cls(
            id=media.id,
            url=media.url,
            alt_text=media.alt_text,
            width=media.width,
            height=media.height,
            blurhash=media.blurhash,
            media_type=media.media_type,
            variant_id=media.variant_id,
            renditions=[RenditionView.model_validate(item) for item in media.renditions],
        )


class RatingView(BaseModel):
    average: float
    count: int


class ProductCard(BaseModel):
    """A product in a grid: listings, collections, search results, related."""

    id: uuid.UUID
    slug: str
    title: str
    subtitle: str | None
    brand: str | None
    price: MoneyJson  # the lowest variant price — "from $28"
    price_max: MoneyJson
    compare_at: MoneyJson | None  # set only when something is on sale
    in_stock: bool
    rating: RatingView | None
    image: MediaView | None
    published_at: datetime | None

    @classmethod
    def of(cls, summary: ProductSummary) -> ProductCard:
        compare_at = (
            MoneyJson(amount=summary.compare_at_max, currency=summary.currency)
            if summary.compare_at_max is not None and summary.compare_at_max > summary.price_min
            else None
        )
        rating = (
            RatingView(average=float(summary.rating_average), count=summary.rating_count)
            if summary.rating_average is not None and summary.rating_count
            else None
        )
        return cls(
            id=summary.id,
            slug=summary.slug,
            title=summary.title,
            subtitle=summary.subtitle,
            brand=summary.brand,
            price=MoneyJson(amount=summary.price_min, currency=summary.currency),
            price_max=MoneyJson(amount=summary.price_max, currency=summary.currency),
            compare_at=compare_at,
            in_stock=summary.in_stock,
            rating=rating,
            image=MediaView.of(summary.image) if summary.image else None,
            published_at=summary.published_at,
        )


class OptionValueView(BaseModel):
    value: str
    swatch_hex: str | None = None


class OptionView(BaseModel):
    name: str
    values: list[OptionValueView]


class AvailabilityView(BaseModel):
    in_stock: bool
    quantity_available: int | None  # shown only when low (API-SPEC.md §2)


class VariantView(BaseModel):
    id: uuid.UUID
    sku: str
    title: str
    price: MoneyJson
    compare_at: MoneyJson | None
    option_values: dict[str, str]
    availability: AvailabilityView


class CategoryRef(BaseModel):
    slug: str
    name: str


class SeoView(BaseModel):
    title: str
    description: str | None


class ProductDetail(BaseModel):
    id: uuid.UUID
    slug: str
    title: str
    subtitle: str | None
    brand: str | None
    description: str | None
    attributes: dict[str, Any]
    category: CategoryRef | None
    breadcrumbs: list[CategoryRef]  # root first, ending with the product's category
    rating: RatingView | None
    in_stock: bool
    options: list[OptionView]
    variants: list[VariantView]
    media: list[MediaView]
    seo: SeoView


class CategoryNode(BaseModel):
    id: uuid.UUID
    slug: str
    name: str
    children: list[CategoryNode]


class CollectionView(BaseModel):
    id: uuid.UUID
    slug: str
    title: str
    description: str | None


class CollectionPage(BaseModel):
    collection: CollectionView
    products: CursorPage[ProductCard]


class CategoryPage(BaseModel):
    category: CategoryRef
    breadcrumbs: list[CategoryRef]
    children: list[CategoryNode]
    products: CursorPage[ProductCard]
