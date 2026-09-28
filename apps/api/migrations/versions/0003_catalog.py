"""Catalog: products, variants, options, categories, collections, media, reviews.

DATA-MODEL.md §4. ``reviews.order_id`` gets its foreign key in 0006, once
``orders`` exists.

Revision ID: 0003
Revises: 0002
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from velo.db.types import Ltree

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "categories",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        sa.Column("parent_id", sa.Uuid(), nullable=True),
        sa.Column("slug", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("path", Ltree(), nullable=False),
        sa.Column("position", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["parent_id"],
            ["categories.id"],
            name=op.f("fk_categories_parent_id_categories"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_categories")),
        sa.UniqueConstraint("slug", name=op.f("uq_categories_slug")),
    )
    op.create_index(
        "idx_categories_path", "categories", ["path"], unique=False, postgresql_using="gist"
    )
    op.create_table(
        "products",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        sa.Column("slug", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("subtitle", sa.Text(), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("brand", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), server_default="draft", nullable=False),
        sa.Column("category_id", sa.Uuid(), nullable=True),
        sa.Column("seo_title", sa.Text(), nullable=True),
        sa.Column("seo_description", sa.Text(), nullable=True),
        sa.Column(
            "attributes",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("rating_average", sa.Numeric(precision=3, scale=2), nullable=True),
        sa.Column("rating_count", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('draft','active','archived')", name=op.f("ck_products_status_valid")
        ),
        sa.ForeignKeyConstraint(
            ["category_id"],
            ["categories.id"],
            name=op.f("fk_products_category_id_categories"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_products")),
        sa.UniqueConstraint("slug", name=op.f("uq_products_slug")),
    )
    op.create_index(
        "idx_products_active",
        "products",
        [sa.literal_column("published_at DESC")],
        unique=False,
        postgresql_where=sa.text("status = 'active' AND deleted_at IS NULL"),
    )
    op.create_index(
        "idx_products_attrs", "products", ["attributes"], unique=False, postgresql_using="gin"
    )
    op.create_index(
        "idx_products_category",
        "products",
        ["category_id"],
        unique=False,
        postgresql_where=sa.text("status = 'active' AND deleted_at IS NULL"),
    )
    op.create_index(
        "idx_products_fts",
        "products",
        [sa.literal_column("to_tsvector('english', title || ' ' || coalesce(description, ''))")],
        unique=False,
        postgresql_using="gin",
    )
    op.create_table(
        "product_variants",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        sa.Column("product_id", sa.Uuid(), nullable=False),
        sa.Column("sku", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("price_amount", sa.BigInteger(), nullable=False),
        sa.Column("price_currency", sa.CHAR(length=3), server_default="USD", nullable=False),
        sa.Column("compare_at_amount", sa.BigInteger(), nullable=True),
        sa.Column("cost_amount", sa.BigInteger(), nullable=True),
        sa.Column("weight_grams", sa.Integer(), nullable=True),
        sa.Column("barcode", sa.Text(), nullable=True),
        sa.Column(
            "requires_shipping", sa.Boolean(), server_default=sa.text("true"), nullable=False
        ),
        sa.Column("is_taxable", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("position", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "compare_at_amount >= 0",
            name=op.f("ck_product_variants_compare_at_amount_non_negative"),
        ),
        sa.CheckConstraint(
            "compare_at_amount IS NULL OR compare_at_amount > price_amount",
            name=op.f("ck_product_variants_compare_at_gt_price"),
        ),
        sa.CheckConstraint(
            "cost_amount >= 0", name=op.f("ck_product_variants_cost_amount_non_negative")
        ),
        sa.CheckConstraint(
            "price_amount >= 0", name=op.f("ck_product_variants_price_amount_non_negative")
        ),
        sa.CheckConstraint(
            "weight_grams >= 0", name=op.f("ck_product_variants_weight_grams_non_negative")
        ),
        sa.ForeignKeyConstraint(
            ["product_id"],
            ["products.id"],
            name=op.f("fk_product_variants_product_id_products"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_product_variants")),
        sa.UniqueConstraint("sku", name=op.f("uq_product_variants_sku")),
    )
    op.create_index(
        "idx_variants_product",
        "product_variants",
        ["product_id"],
        unique=False,
        postgresql_where=sa.text("deleted_at IS NULL"),
    )
    op.create_table(
        "product_options",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        sa.Column("product_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("position", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.ForeignKeyConstraint(
            ["product_id"],
            ["products.id"],
            name=op.f("fk_product_options_product_id_products"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_product_options")),
        sa.UniqueConstraint("product_id", "name", name=op.f("uq_product_options_product_id_name")),
    )
    op.create_table(
        "option_values",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        sa.Column("option_id", sa.Uuid(), nullable=False),
        sa.Column("value", sa.Text(), nullable=False),
        sa.Column("swatch_hex", sa.Text(), nullable=True),
        sa.Column("position", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.ForeignKeyConstraint(
            ["option_id"],
            ["product_options.id"],
            name=op.f("fk_option_values_option_id_product_options"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_option_values")),
        sa.UniqueConstraint("option_id", "value", name=op.f("uq_option_values_option_id_value")),
    )
    op.create_table(
        "variant_option_values",
        sa.Column("variant_id", sa.Uuid(), nullable=False),
        sa.Column("option_value_id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(
            ["option_value_id"],
            ["option_values.id"],
            name=op.f("fk_variant_option_values_option_value_id_option_values"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["variant_id"],
            ["product_variants.id"],
            name=op.f("fk_variant_option_values_variant_id_product_variants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "variant_id", "option_value_id", name=op.f("pk_variant_option_values")
        ),
    )
    op.create_table(
        "collections",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        sa.Column("slug", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("rules", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_collections")),
        sa.UniqueConstraint("slug", name=op.f("uq_collections_slug")),
    )
    op.create_table(
        "product_collections",
        sa.Column("product_id", sa.Uuid(), nullable=False),
        sa.Column("collection_id", sa.Uuid(), nullable=False),
        sa.Column("position", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.ForeignKeyConstraint(
            ["collection_id"],
            ["collections.id"],
            name=op.f("fk_product_collections_collection_id_collections"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["product_id"],
            ["products.id"],
            name=op.f("fk_product_collections_product_id_products"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("product_id", "collection_id", name=op.f("pk_product_collections")),
    )
    op.create_table(
        "product_media",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        sa.Column("product_id", sa.Uuid(), nullable=False),
        sa.Column("variant_id", sa.Uuid(), nullable=True),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("alt_text", sa.Text(), nullable=True),
        sa.Column("width", sa.Integer(), nullable=True),
        sa.Column("height", sa.Integer(), nullable=True),
        sa.Column("blurhash", sa.Text(), nullable=True),
        sa.Column("media_type", sa.Text(), server_default="image", nullable=False),
        sa.Column("position", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.CheckConstraint(
            "media_type IN ('image','video')", name=op.f("ck_product_media_media_type_valid")
        ),
        sa.ForeignKeyConstraint(
            ["product_id"],
            ["products.id"],
            name=op.f("fk_product_media_product_id_products"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["variant_id"],
            ["product_variants.id"],
            name=op.f("fk_product_media_variant_id_product_variants"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_product_media")),
    )
    op.create_index("idx_media_product", "product_media", ["product_id", "position"], unique=False)
    op.create_table(
        "reviews",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        sa.Column("product_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column("order_id", sa.Uuid(), nullable=True),
        sa.Column("rating", sa.SmallInteger(), nullable=False),
        sa.Column("title", sa.Text(), nullable=True),
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), server_default="pending", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('pending','approved','rejected')", name=op.f("ck_reviews_status_valid")
        ),
        sa.CheckConstraint("rating BETWEEN 1 AND 5", name=op.f("ck_reviews_rating_range")),
        sa.ForeignKeyConstraint(
            ["product_id"],
            ["products.id"],
            name=op.f("fk_reviews_product_id_products"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_reviews_user_id_users"), ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_reviews")),
    )
    op.create_index(
        "idx_reviews_product",
        "reviews",
        ["product_id", sa.literal_column("created_at DESC")],
        unique=False,
        postgresql_where=sa.text("status = 'approved'"),
    )
    op.create_index(
        "uq_review_per_order_product",
        "reviews",
        ["user_id", "product_id", "order_id"],
        unique=True,
        postgresql_where=sa.text("user_id IS NOT NULL AND order_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_table("reviews")
    op.drop_table("product_media")
    op.drop_table("product_collections")
    op.drop_table("collections")
    op.drop_table("variant_option_values")
    op.drop_table("option_values")
    op.drop_table("product_options")
    op.drop_table("product_variants")
    op.drop_table("products")
    op.drop_table("categories")
