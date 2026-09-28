"""Catalog tables — DATA-MODEL.md §4.

The only soft-deleted part of the schema: a product that has been sold must
stay resolvable, so it is hidden, not removed.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    CHAR,
    CheckConstraint,
    ForeignKey,
    Index,
    Numeric,
    SmallInteger,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from velo.db.base import (
    Base,
    HasCreatedAt,
    HasId,
    HasTimestamps,
    JsonObject,
    SoftDeletable,
    json_object,
    non_negative,
    one_of,
)
from velo.db.types import Ltree, MinorUnits

PRODUCT_STATUSES = ("draft", "active", "archived")
REVIEW_STATUSES = ("pending", "approved", "rejected")

_LIVE = text("status = 'active' AND deleted_at IS NULL")


class Category(HasId, HasCreatedAt, Base):
    __tablename__ = "categories"

    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("categories.id", ondelete="CASCADE")
    )
    slug: Mapped[str] = mapped_column(unique=True)
    name: Mapped[str]
    path: Mapped[str] = mapped_column(Ltree)  # 'apparel.tops.tshirts': a subtree in one query
    position: Mapped[int] = mapped_column(server_default=text("0"))

    __table_args__ = (Index("idx_categories_path", "path", postgresql_using="gist"),)


class Product(HasId, HasTimestamps, SoftDeletable, Base):
    __tablename__ = "products"

    slug: Mapped[str] = mapped_column(unique=True)
    title: Mapped[str]
    subtitle: Mapped[str | None]
    description: Mapped[str | None]
    brand: Mapped[str | None]
    status: Mapped[str] = mapped_column(server_default="draft")
    category_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("categories.id", ondelete="SET NULL")
    )
    seo_title: Mapped[str | None]
    seo_description: Mapped[str | None]
    attributes: Mapped[JsonObject] = json_object()  # material, care, dimensions, …
    rating_average: Mapped[Decimal | None] = mapped_column(Numeric(3, 2))  # denormalised
    rating_count: Mapped[int] = mapped_column(server_default=text("0"))
    published_at: Mapped[datetime | None]

    __table_args__ = (
        one_of("status", *PRODUCT_STATUSES),
        Index("idx_products_active", text("published_at DESC"), postgresql_where=_LIVE),
        Index("idx_products_category", "category_id", postgresql_where=_LIVE),
        Index("idx_products_attrs", "attributes", postgresql_using="gin"),
        # The Postgres full-text fallback for when Meilisearch is down (ADR-007).
        Index(
            "idx_products_fts",
            text("to_tsvector('english', title || ' ' || coalesce(description, ''))"),
            postgresql_using="gin",
        ),
    )


class ProductVariant(HasId, HasTimestamps, SoftDeletable, Base):
    __tablename__ = "product_variants"

    product_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"))
    sku: Mapped[str] = mapped_column(unique=True)
    title: Mapped[str]  # "Large / Navy"
    price_amount: Mapped[int] = mapped_column(MinorUnits)
    price_currency: Mapped[str] = mapped_column(CHAR(3), server_default="USD")
    compare_at_amount: Mapped[int | None] = mapped_column(MinorUnits)
    cost_amount: Mapped[int | None] = mapped_column(MinorUnits)  # margin reporting
    weight_grams: Mapped[int | None]
    barcode: Mapped[str | None]
    requires_shipping: Mapped[bool] = mapped_column(server_default=text("true"))
    is_taxable: Mapped[bool] = mapped_column(server_default=text("true"))
    position: Mapped[int] = mapped_column(server_default=text("0"))

    __table_args__ = (
        *non_negative("price_amount", "compare_at_amount", "cost_amount", "weight_grams"),
        CheckConstraint(
            "compare_at_amount IS NULL OR compare_at_amount > price_amount",
            name="compare_at_gt_price",
        ),
        Index("idx_variants_product", "product_id", postgresql_where=text("deleted_at IS NULL")),
    )


class ProductOption(HasId, Base):
    """One axis of the option matrix — 'Size', 'Colour'."""

    __tablename__ = "product_options"

    product_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"))
    name: Mapped[str]
    position: Mapped[int] = mapped_column(server_default=text("0"))

    __table_args__ = (UniqueConstraint("product_id", "name"),)


class OptionValue(HasId, Base):
    __tablename__ = "option_values"

    option_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("product_options.id", ondelete="CASCADE")
    )
    value: Mapped[str]  # 'Large'
    swatch_hex: Mapped[str | None]
    position: Mapped[int] = mapped_column(server_default=text("0"))

    __table_args__ = (UniqueConstraint("option_id", "value"),)


class VariantOptionValue(Base):
    __tablename__ = "variant_option_values"

    variant_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("product_variants.id", ondelete="CASCADE"), primary_key=True
    )
    option_value_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("option_values.id", ondelete="CASCADE"), primary_key=True
    )


class Collection(HasId, HasCreatedAt, Base):
    __tablename__ = "collections"

    slug: Mapped[str] = mapped_column(unique=True)
    title: Mapped[str]
    description: Mapped[str | None]
    rules: Mapped[JsonObject | None]  # NULL = manual; non-NULL = smart collection
    is_active: Mapped[bool] = mapped_column(server_default=text("true"))


class ProductCollection(Base):
    __tablename__ = "product_collections"

    product_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"), primary_key=True
    )
    collection_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("collections.id", ondelete="CASCADE"), primary_key=True
    )
    position: Mapped[int] = mapped_column(server_default=text("0"))


class ProductMedia(HasId, Base):
    __tablename__ = "product_media"

    product_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"))
    variant_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("product_variants.id", ondelete="SET NULL")
    )
    url: Mapped[str]
    alt_text: Mapped[str | None]  # required for WCAG; enforced in the admin UI
    # Intrinsic size, so the storefront reserves the space and nothing shifts (CLS).
    width: Mapped[int | None]
    height: Mapped[int | None]
    blurhash: Mapped[str | None]
    media_type: Mapped[str] = mapped_column(server_default="image")
    position: Mapped[int] = mapped_column(server_default=text("0"))

    __table_args__ = (
        one_of("media_type", "image", "video"),
        Index("idx_media_product", "product_id", "position"),
    )


class Review(HasId, HasCreatedAt, Base):
    __tablename__ = "reviews"

    product_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"))
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    # A verified purchase. The foreign key is added by the orders migration,
    # which runs after this one.
    order_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("orders.id", ondelete="SET NULL"))
    rating: Mapped[int] = mapped_column(SmallInteger)
    title: Mapped[str | None]
    body: Mapped[str | None]
    status: Mapped[str] = mapped_column(server_default="pending")

    __table_args__ = (
        CheckConstraint("rating BETWEEN 1 AND 5", name="rating_range"),
        one_of("status", *REVIEW_STATUSES),
        Index(
            "idx_reviews_product",
            "product_id",
            text("created_at DESC"),
            postgresql_where=text("status = 'approved'"),
        ),
        Index(
            "uq_review_per_order_product",
            "user_id",
            "product_id",
            "order_id",
            unique=True,
            postgresql_where=text("user_id IS NOT NULL AND order_id IS NOT NULL"),
        ),
    )
