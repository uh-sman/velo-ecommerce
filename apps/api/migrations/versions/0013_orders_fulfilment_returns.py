"""Orders, fulfilment, refunds and returns: what Phase 9 needs beyond the Phase 4 schema.

PLANNING.md Phase 9.

- ``refund_items`` records which lines a refund paid back, and how many of
  each, so a line can be refunded in parts and never beyond what was bought
  (PAYMENTS-AND-CHECKOUT.md §8: "partial refunds are tracked per line item").
- ``refunds`` gains ``submitted_at``, ``attempts`` and ``last_error``: a refund
  row is written before the provider is called, and one left unsubmitted by a
  crash is retried by reconciliation under its own id as the idempotency key.
- Indexes for the new lookups: fulfilments by order and by tracking number
  (carrier webhooks), returns by order and by status (the admin queue),
  refunds by payment, and order lines by SKU (order search).

Revision ID: 0013
Revises: 0012
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0013"
down_revision: str | None = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("refunds", sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "refunds",
        sa.Column("attempts", sa.Integer(), server_default=sa.text("0"), nullable=False),
    )
    op.add_column("refunds", sa.Column("last_error", sa.Text(), nullable=True))
    # Refunds that already exist were issued by providers and recorded from webhooks.
    op.execute("UPDATE refunds SET submitted_at = created_at")
    op.create_index("idx_refunds_payment", "refunds", ["payment_id"], unique=False)
    op.create_index(
        "idx_refunds_unsubmitted",
        "refunds",
        ["created_at"],
        unique=False,
        postgresql_where=sa.text("status = 'pending' AND submitted_at IS NULL"),
    )

    op.create_table(
        "refund_items",
        sa.Column("refund_id", sa.Uuid(), nullable=False),
        sa.Column("order_item_id", sa.Uuid(), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("amount", sa.BigInteger(), nullable=False),
        sa.Column("restock", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.CheckConstraint("quantity > 0", name=op.f("ck_refund_items_quantity_positive")),
        sa.CheckConstraint("amount >= 0", name=op.f("ck_refund_items_amount_non_negative")),
        sa.ForeignKeyConstraint(
            ["order_item_id"],
            ["order_items.id"],
            name=op.f("fk_refund_items_order_item_id_order_items"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["refund_id"],
            ["refunds.id"],
            name=op.f("fk_refund_items_refund_id_refunds"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("refund_id", "order_item_id", name=op.f("pk_refund_items")),
    )
    op.create_index("idx_refund_items_item", "refund_items", ["order_item_id"], unique=False)

    op.create_index("idx_fulfilments_order", "fulfilments", ["order_id"], unique=False)
    op.create_index("idx_fulfilments_tracking", "fulfilments", ["tracking_number"], unique=False)
    op.create_index("idx_returns_order", "returns", ["order_id"], unique=False)
    op.create_index("idx_returns_status", "returns", ["status", "created_at"], unique=False)
    op.create_index("idx_order_items_sku", "order_items", ["sku"], unique=False)


def downgrade() -> None:
    op.drop_index("idx_order_items_sku", table_name="order_items")
    op.drop_index("idx_returns_status", table_name="returns")
    op.drop_index("idx_returns_order", table_name="returns")
    op.drop_index("idx_fulfilments_tracking", table_name="fulfilments")
    op.drop_index("idx_fulfilments_order", table_name="fulfilments")
    op.drop_index("idx_refund_items_item", table_name="refund_items")
    op.drop_table("refund_items")
    op.drop_index(
        "idx_refunds_unsubmitted",
        table_name="refunds",
        postgresql_where=sa.text("status = 'pending' AND submitted_at IS NULL"),
    )
    op.drop_index("idx_refunds_payment", table_name="refunds")
    op.drop_column("refunds", "last_error")
    op.drop_column("refunds", "attempts")
    op.drop_column("refunds", "submitted_at")
