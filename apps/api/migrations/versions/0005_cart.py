"""Cart: carts and cart items.

DATA-MODEL.md §6.

Revision ID: 0005
Revises: 0004
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "carts",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column("guest_token", sa.Text(), nullable=True),
        sa.Column("currency", sa.CHAR(length=3), server_default="USD", nullable=False),
        sa.Column("status", sa.Text(), server_default="active", nullable=False),
        sa.Column("abandoned_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "expires_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now() + interval '30 days'"),
            nullable=False,
        ),
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
        sa.CheckConstraint(
            "status IN ('active','converted','abandoned','merged')",
            name=op.f("ck_carts_status_valid"),
        ),
        sa.CheckConstraint(
            "user_id IS NOT NULL OR guest_token IS NOT NULL", name=op.f("ck_carts_cart_has_owner")
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_carts_user_id_users"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_carts")),
        sa.UniqueConstraint("guest_token", name=op.f("uq_carts_guest_token")),
    )
    op.create_index(
        "idx_carts_abandoned",
        "carts",
        ["abandoned_at"],
        unique=False,
        postgresql_where=sa.text("status = 'abandoned'"),
    )
    op.create_index(
        "uq_active_user_cart",
        "carts",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("status = 'active' AND user_id IS NOT NULL"),
    )
    op.create_table(
        "cart_items",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        sa.Column("cart_id", sa.Uuid(), nullable=False),
        sa.Column("variant_id", sa.Uuid(), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
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
        sa.CheckConstraint(
            "quantity > 0 AND quantity <= 999", name=op.f("ck_cart_items_quantity_range")
        ),
        sa.ForeignKeyConstraint(
            ["cart_id"], ["carts.id"], name=op.f("fk_cart_items_cart_id_carts"), ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["variant_id"],
            ["product_variants.id"],
            name=op.f("fk_cart_items_variant_id_product_variants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_cart_items")),
        sa.UniqueConstraint("cart_id", "variant_id", name=op.f("uq_cart_items_cart_id_variant_id")),
    )


def downgrade() -> None:
    op.drop_table("cart_items")
    op.drop_table("carts")
