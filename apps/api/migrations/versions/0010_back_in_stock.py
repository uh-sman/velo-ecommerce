"""Back-in-stock subscriptions, and media renditions.

PLANNING.md Phase 6. One pending back-in-stock request per variant and email;
a row is kept after it is notified, as a record of what was sent.
``product_media.renditions`` lists the resized copies the worker wrote.
``idx_variant_option_values_value`` serves colour and size filters, which look
variants up by option value — the reverse of the primary key's order.

Revision ID: 0010
Revises: 0009
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0010"
down_revision: str | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "back_in_stock_subscriptions",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        sa.Column("variant_id", sa.Uuid(), nullable=False),
        sa.Column("email", postgresql.CITEXT(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column("notified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_back_in_stock_subscriptions_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["variant_id"],
            ["product_variants.id"],
            name=op.f("fk_back_in_stock_subscriptions_variant_id_product_variants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_back_in_stock_subscriptions")),
    )
    op.create_index(
        "uq_back_in_stock_pending",
        "back_in_stock_subscriptions",
        ["variant_id", "email"],
        unique=True,
        postgresql_where=sa.text("notified_at IS NULL"),
    )
    op.add_column(
        "product_media",
        sa.Column(
            "renditions",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
    )
    op.create_index("idx_variant_option_values_value", "variant_option_values", ["option_value_id"])


def downgrade() -> None:
    op.drop_index("idx_variant_option_values_value", table_name="variant_option_values")
    op.drop_column("product_media", "renditions")
    op.drop_index("uq_back_in_stock_pending", table_name="back_in_stock_subscriptions")
    op.drop_table("back_in_stock_subscriptions")
