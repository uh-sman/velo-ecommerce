"""Commerce rules: discounts, shipping zones and rates, tax rates.

DATA-MODEL.md §9. ``discount_redemptions`` references ``orders`` and is
created in 0006.

Revision ID: 0004
Revises: 0003
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "discounts",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        sa.Column("code", postgresql.CITEXT(), nullable=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("type", sa.Text(), nullable=False),
        sa.Column("value", sa.Numeric(precision=10, scale=4), nullable=False),
        sa.Column("currency", sa.CHAR(length=3), nullable=True),
        sa.Column("min_subtotal_amount", sa.BigInteger(), nullable=True),
        sa.Column("applies_to", sa.Text(), server_default="all", nullable=False),
        sa.Column("target_ids", postgresql.ARRAY(sa.Uuid()), nullable=True),
        sa.Column(
            "first_order_only", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
        sa.Column("max_redemptions", sa.Integer(), nullable=True),
        sa.Column("max_per_customer", sa.Integer(), nullable=True),
        sa.Column("times_redeemed", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("is_stackable", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "starts_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "applies_to IN ('all','products','collections')",
            name=op.f("ck_discounts_applies_to_valid"),
        ),
        sa.CheckConstraint(
            "type IN ('percentage','fixed_amount','free_shipping','buy_x_get_y')",
            name=op.f("ck_discounts_type_valid"),
        ),
        sa.CheckConstraint(
            "ends_at IS NULL OR ends_at > starts_at", name=op.f("ck_discounts_valid_window")
        ),
        sa.CheckConstraint(
            "max_redemptions IS NULL OR times_redeemed <= max_redemptions",
            name=op.f("ck_discounts_within_limit"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_discounts")),
        sa.UniqueConstraint("code", name=op.f("uq_discounts_code")),
    )
    op.create_index(
        "idx_discounts_active",
        "discounts",
        ["code"],
        unique=False,
        postgresql_where=sa.text("is_active"),
    )
    op.create_table(
        "shipping_zones",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("country_codes", postgresql.ARRAY(sa.CHAR(length=2)), nullable=False),
        sa.Column("regions", postgresql.ARRAY(sa.Text()), nullable=True),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_shipping_zones")),
    )
    op.create_table(
        "shipping_rates",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        sa.Column("zone_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("price_amount", sa.BigInteger(), nullable=False),
        sa.Column("currency", sa.CHAR(length=3), server_default="USD", nullable=False),
        sa.Column("min_subtotal_amount", sa.BigInteger(), nullable=True),
        sa.Column("max_subtotal_amount", sa.BigInteger(), nullable=True),
        sa.Column("min_weight_grams", sa.Integer(), nullable=True),
        sa.Column("max_weight_grams", sa.Integer(), nullable=True),
        sa.Column("est_days_min", sa.Integer(), nullable=True),
        sa.Column("est_days_max", sa.Integer(), nullable=True),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("position", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.CheckConstraint(
            "price_amount >= 0", name=op.f("ck_shipping_rates_price_amount_non_negative")
        ),
        sa.ForeignKeyConstraint(
            ["zone_id"],
            ["shipping_zones.id"],
            name=op.f("fk_shipping_rates_zone_id_shipping_zones"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_shipping_rates")),
    )
    op.create_index(
        "idx_rates_zone",
        "shipping_rates",
        ["zone_id"],
        unique=False,
        postgresql_where=sa.text("is_active"),
    )
    op.create_table(
        "tax_rates",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("country_code", sa.CHAR(length=2), nullable=False),
        sa.Column("region", sa.Text(), nullable=True),
        sa.Column("postal_prefix", sa.Text(), nullable=True),
        sa.Column("rate", sa.Numeric(precision=6, scale=4), nullable=False),
        sa.Column("is_inclusive", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("priority", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.CheckConstraint("rate >= 0 AND rate <= 1", name=op.f("ck_tax_rates_rate_range")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_tax_rates")),
    )
    op.create_index(
        "idx_tax_lookup",
        "tax_rates",
        ["country_code", "region"],
        unique=False,
        postgresql_where=sa.text("is_active"),
    )


def downgrade() -> None:
    op.drop_table("tax_rates")
    op.drop_table("shipping_rates")
    op.drop_table("shipping_zones")
    op.drop_table("discounts")
