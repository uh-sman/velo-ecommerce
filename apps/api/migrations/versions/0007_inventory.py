"""Inventory: stock levels, the movement ledger, reservations.

DATA-MODEL.md §5 — the oversell guard.

Revision ID: 0007
Revises: 0006
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "inventory_items",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        sa.Column("variant_id", sa.Uuid(), nullable=False),
        sa.Column("quantity_on_hand", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("quantity_reserved", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("reorder_point", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("track_inventory", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("allow_backorder", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "quantity_on_hand >= 0", name=op.f("ck_inventory_items_quantity_on_hand_non_negative")
        ),
        sa.CheckConstraint(
            "quantity_reserved <= quantity_on_hand",
            name=op.f("ck_inventory_items_reserved_within_stock"),
        ),
        sa.CheckConstraint(
            "quantity_reserved >= 0", name=op.f("ck_inventory_items_quantity_reserved_non_negative")
        ),
        sa.ForeignKeyConstraint(
            ["variant_id"],
            ["product_variants.id"],
            name=op.f("fk_inventory_items_variant_id_product_variants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_inventory_items")),
        sa.UniqueConstraint("variant_id", name=op.f("uq_inventory_items_variant_id")),
    )
    op.create_index(
        "idx_inventory_low",
        "inventory_items",
        ["variant_id"],
        unique=False,
        postgresql_where=sa.text("quantity_on_hand <= reorder_point"),
    )
    op.create_table(
        "inventory_movements",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        sa.Column("variant_id", sa.Uuid(), nullable=False),
        sa.Column("quantity_delta", sa.Integer(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("reference_type", sa.Text(), nullable=True),
        sa.Column("reference_id", sa.Uuid(), nullable=True),
        sa.Column("actor_id", sa.Uuid(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "reason IN ('sale','return','restock','adjustment','damage','theft','initial')",
            name=op.f("ck_inventory_movements_reason_valid"),
        ),
        sa.ForeignKeyConstraint(
            ["actor_id"], ["users.id"], name=op.f("fk_inventory_movements_actor_id_users")
        ),
        sa.ForeignKeyConstraint(
            ["variant_id"],
            ["product_variants.id"],
            name=op.f("fk_inventory_movements_variant_id_product_variants"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_inventory_movements")),
    )
    op.create_index(
        "idx_movements_ref", "inventory_movements", ["reference_type", "reference_id"], unique=False
    )
    op.create_index(
        "idx_movements_variant",
        "inventory_movements",
        ["variant_id", sa.literal_column("created_at DESC")],
        unique=False,
    )
    op.create_table(
        "inventory_reservations",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        sa.Column("variant_id", sa.Uuid(), nullable=False),
        sa.Column("checkout_session_id", sa.Uuid(), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("status", sa.Text(), server_default="active", nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('active','committed','released','expired')",
            name=op.f("ck_inventory_reservations_status_valid"),
        ),
        sa.CheckConstraint(
            "quantity > 0", name=op.f("ck_inventory_reservations_quantity_positive")
        ),
        sa.ForeignKeyConstraint(
            ["checkout_session_id"],
            ["checkout_sessions.id"],
            name=op.f("fk_inventory_reservations_checkout_session_id_checkout_sessions"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["variant_id"],
            ["product_variants.id"],
            name=op.f("fk_inventory_reservations_variant_id_product_variants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_inventory_reservations")),
    )
    op.create_index(
        "idx_reservations_expiry",
        "inventory_reservations",
        ["expires_at"],
        unique=False,
        postgresql_where=sa.text("status = 'active'"),
    )
    op.create_index(
        "idx_reservations_session", "inventory_reservations", ["checkout_session_id"], unique=False
    )


def downgrade() -> None:
    op.drop_table("inventory_reservations")
    op.drop_table("inventory_movements")
    op.drop_table("inventory_items")
