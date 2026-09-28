"""Request bodies for catalog writes, and the admin's views of catalog data.

Every request model forbids unknown fields (API-SPEC.md §3, rule 8). Money is
integer minor units; a float is refused at the boundary (ADR-005).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, StrictInt, StringConstraints

from velo.core.pagination import MoneyJson
from velo.domains.catalog.views import MediaView, OptionView

Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Slug = Annotated[
    str,
    StringConstraints(strip_whitespace=True, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$", max_length=120),
]
Text = Annotated[str, StringConstraints(strip_whitespace=True, max_length=20_000)]
Short = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
Currency = Annotated[str, StringConstraints(pattern=r"^[A-Z]{3}$")]
Hex = Annotated[str, StringConstraints(pattern=r"^#[0-9A-Fa-f]{6}$")]
Amount = Annotated[StrictInt, Field(ge=0)]  # StrictInt: 29.99 is a 422, not 29
ProductStatus = Literal["draft", "active", "archived"]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ── Products and variants ─────────────────────────────────────────────────────


class OptionValueInput(RequestModel):
    value: Short
    swatch_hex: Hex | None = None


class VariantInput(RequestModel):
    sku: Short
    price: Amount
    currency: Currency = "USD"
    compare_at: Amount | None = None
    cost: Amount | None = None
    weight_grams: Annotated[StrictInt, Field(ge=0)] | None = None
    barcode: Short | None = None
    requires_shipping: bool = True
    is_taxable: bool = True
    # {"Size": "M", "Colour": "Navy"} — options are created on the product as needed.
    options: dict[Short, Short] = Field(default_factory=dict)
    swatches: dict[Short, Hex] = Field(default_factory=dict, description="Colour value → hex.")
    title: Title | None = Field(default=None, description="Defaults to the option values joined.")
    stock: Annotated[StrictInt, Field(ge=0)] = 0
    reorder_point: Annotated[StrictInt, Field(ge=0)] = 5
    track_inventory: bool = True
    allow_backorder: bool = False


class VariantUpdate(RequestModel):
    sku: Short | None = None
    price: Amount | None = None
    compare_at: Amount | None = None
    cost: Amount | None = None
    weight_grams: Annotated[StrictInt, Field(ge=0)] | None = None
    barcode: Short | None = None
    requires_shipping: bool | None = None
    is_taxable: bool | None = None
    options: dict[Short, Short] | None = None
    swatches: dict[Short, Hex] = Field(default_factory=dict)
    title: Title | None = None


class ProductCreate(RequestModel):
    title: Title
    slug: Slug | None = Field(default=None, description="Defaults to the title, made unique.")
    subtitle: Title | None = None
    description: Text | None = None
    brand: Short | None = None
    status: ProductStatus = "draft"
    category: Slug | None = Field(default=None, description="Category slug.")
    seo_title: Title | None = None
    seo_description: Annotated[str, StringConstraints(max_length=320)] | None = None
    attributes: dict[str, Any] = Field(default_factory=dict)
    variants: list[VariantInput] = Field(default_factory=list, max_length=250)
    collections: list[Slug] = Field(default_factory=list)


class ProductUpdate(RequestModel):
    title: Title | None = None
    slug: Slug | None = None
    subtitle: Title | None = None
    description: Text | None = None
    brand: Short | None = None
    status: ProductStatus | None = None
    category: Slug | None = None
    seo_title: Title | None = None
    seo_description: Annotated[str, StringConstraints(max_length=320)] | None = None
    attributes: dict[str, Any] | None = None
    collections: list[Slug] | None = None


# ── Categories and collections ────────────────────────────────────────────────


class CategoryCreate(RequestModel):
    name: Title
    slug: Slug | None = None
    parent: Slug | None = None
    position: Annotated[StrictInt, Field(ge=0)] = 0


class CategoryUpdate(RequestModel):
    name: Title | None = None
    slug: Slug | None = None
    parent: Slug | None = Field(default=None, description="Move under this category.")
    move_to_root: bool = False
    position: Annotated[StrictInt, Field(ge=0)] | None = None


class CollectionCreate(RequestModel):
    title: Title
    slug: Slug | None = None
    description: Text | None = None
    is_active: bool = True
    products: list[uuid.UUID] = Field(default_factory=list, max_length=1000)


class CollectionUpdate(RequestModel):
    title: Title | None = None
    slug: Slug | None = None
    description: Text | None = None
    is_active: bool | None = None
    products: list[uuid.UUID] | None = Field(default=None, max_length=1000)


# ── Media ─────────────────────────────────────────────────────────────────────

ImageType = Literal["image/jpeg", "image/png", "image/webp", "image/avif"]


class PresignRequest(RequestModel):
    product_id: uuid.UUID
    content_type: ImageType
    filename: Annotated[str, StringConstraints(max_length=200)] = "upload"


class PresignResponse(BaseModel):
    url: str
    fields: dict[str, str]
    key: str
    expires_in: int
    max_bytes: int


class MediaAttach(RequestModel):
    key: Annotated[str, StringConstraints(max_length=400)]
    alt_text: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)]
    variant_id: uuid.UUID | None = None


class MediaUpdate(RequestModel):
    alt_text: (
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)]
        | None
    ) = None
    position: Annotated[StrictInt, Field(ge=0)] | None = None
    variant_id: uuid.UUID | None = None
    detach_variant: bool = False


# ── Reviews ───────────────────────────────────────────────────────────────────


class ReviewCreate(RequestModel):
    rating: Annotated[StrictInt, Field(ge=1, le=5)]
    title: Annotated[str, StringConstraints(strip_whitespace=True, max_length=120)] | None = None
    body: Annotated[str, StringConstraints(strip_whitespace=True, max_length=5000)] | None = None


class ReviewModeration(RequestModel):
    status: Literal["approved", "rejected"]


class ReviewView(BaseModel):
    id: uuid.UUID
    rating: int
    title: str | None
    body: str | None
    author: str | None
    verified_purchase: bool
    created_at: datetime


class AdminReviewView(ReviewView):
    product_id: uuid.UUID
    user_id: uuid.UUID | None
    status: str


# ── Back in stock ─────────────────────────────────────────────────────────────


class BackInStockRequest(RequestModel):
    variant_id: uuid.UUID
    email: EmailStr | None = Field(default=None, description="Required when not signed in.")


# ── Admin views ───────────────────────────────────────────────────────────────


class StockView(BaseModel):
    quantity_on_hand: int
    quantity_reserved: int
    available: int
    reorder_point: int
    track_inventory: bool
    allow_backorder: bool


class AdminVariantView(BaseModel):
    id: uuid.UUID
    sku: str
    title: str
    price: MoneyJson
    compare_at: MoneyJson | None
    cost: MoneyJson | None
    weight_grams: int | None
    barcode: str | None
    requires_shipping: bool
    is_taxable: bool
    position: int
    option_values: dict[str, str]
    stock: StockView | None


class AdminProductView(BaseModel):
    id: uuid.UUID
    slug: str
    title: str
    subtitle: str | None
    description: str | None
    brand: str | None
    status: str
    category: str | None  # slug
    seo_title: str | None
    seo_description: str | None
    attributes: dict[str, Any]
    rating_average: float | None
    rating_count: int
    published_at: datetime | None
    created_at: datetime
    updated_at: datetime
    options: list[OptionView]
    variants: list[AdminVariantView]
    media: list[MediaView]
    collections: list[str]


class AdminProductRow(BaseModel):
    id: uuid.UUID
    slug: str
    title: str
    status: str
    brand: str | None
    price: MoneyJson | None
    in_stock: bool
    updated_at: datetime
    image: MediaView | None


class AdminCategoryView(BaseModel):
    id: uuid.UUID
    slug: str
    name: str
    parent_id: uuid.UUID | None
    path: str
    position: int


class AdminCollectionView(BaseModel):
    id: uuid.UUID
    slug: str
    title: str
    description: str | None
    is_active: bool
    products: list[uuid.UUID]
