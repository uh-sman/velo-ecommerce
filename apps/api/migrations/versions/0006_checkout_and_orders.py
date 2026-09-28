"""Checkout and orders: sessions, orders, items, events, fulfilments, returns.

DATA-MODEL.md §7, plus ``discount_redemptions`` (§9) and the
``reviews.order_id`` foreign key deferred from 0003.

Revision ID: 0006
Revises: 0005
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "checkout_sessions",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        sa.Column("cart_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column("email", postgresql.CITEXT(), nullable=False),
        sa.Column("status", sa.Text(), server_default="initiated", nullable=False),
        sa.Column("shipping_address_id", sa.Uuid(), nullable=True),
        sa.Column("billing_address_id", sa.Uuid(), nullable=True),
        sa.Column("shipping_rate_id", sa.Uuid(), nullable=True),
        sa.Column("discount_id", sa.Uuid(), nullable=True),
        sa.Column("currency", sa.CHAR(length=3), server_default="USD", nullable=False),
        sa.Column("subtotal_amount", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("discount_amount", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("shipping_amount", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("tax_amount", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("total_amount", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column(
            "expires_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now() + interval '30 minutes'"),
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
            "status IN ('initiated','address_set','shipping_set','payment_pending','confirmed','failed','expired','abandoned')",
            name=op.f("ck_checkout_sessions_status_valid"),
        ),
        sa.CheckConstraint(
            "discount_amount <= subtotal_amount",
            name=op.f("ck_checkout_sessions_discount_within_subtotal"),
        ),
        sa.CheckConstraint(
            "discount_amount >= 0", name=op.f("ck_checkout_sessions_discount_amount_non_negative")
        ),
        sa.CheckConstraint(
            "shipping_amount >= 0", name=op.f("ck_checkout_sessions_shipping_amount_non_negative")
        ),
        sa.CheckConstraint(
            "subtotal_amount >= 0", name=op.f("ck_checkout_sessions_subtotal_amount_non_negative")
        ),
        sa.CheckConstraint(
            "tax_amount >= 0", name=op.f("ck_checkout_sessions_tax_amount_non_negative")
        ),
        sa.CheckConstraint(
            "total_amount = subtotal_amount - discount_amount + shipping_amount + tax_amount",
            name=op.f("ck_checkout_sessions_totals_balance"),
        ),
        sa.CheckConstraint(
            "total_amount >= 0", name=op.f("ck_checkout_sessions_total_amount_non_negative")
        ),
        sa.ForeignKeyConstraint(
            ["billing_address_id"],
            ["addresses.id"],
            name=op.f("fk_checkout_sessions_billing_address_id_addresses"),
        ),
        sa.ForeignKeyConstraint(
            ["cart_id"], ["carts.id"], name=op.f("fk_checkout_sessions_cart_id_carts")
        ),
        sa.ForeignKeyConstraint(
            ["discount_id"],
            ["discounts.id"],
            name=op.f("fk_checkout_sessions_discount_id_discounts"),
        ),
        sa.ForeignKeyConstraint(
            ["shipping_address_id"],
            ["addresses.id"],
            name=op.f("fk_checkout_sessions_shipping_address_id_addresses"),
        ),
        sa.ForeignKeyConstraint(
            ["shipping_rate_id"],
            ["shipping_rates.id"],
            name=op.f("fk_checkout_sessions_shipping_rate_id_shipping_rates"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_checkout_sessions_user_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_checkout_sessions")),
    )
    op.create_index(
        "idx_checkout_expiry",
        "checkout_sessions",
        ["expires_at"],
        unique=False,
        postgresql_where=sa.text("status NOT IN ('confirmed','failed','expired')"),
    )
    op.create_table(
        "orders",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        sa.Column("order_number", sa.Text(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column("email", postgresql.CITEXT(), nullable=False),
        sa.Column("checkout_session_id", sa.Uuid(), nullable=True),
        sa.Column("status", sa.Text(), server_default="pending", nullable=False),
        sa.Column("payment_status", sa.Text(), server_default="pending", nullable=False),
        sa.Column("fulfilment_status", sa.Text(), server_default="unfulfilled", nullable=False),
        sa.Column("currency", sa.CHAR(length=3), nullable=False),
        sa.Column("subtotal_amount", sa.BigInteger(), nullable=False),
        sa.Column("discount_amount", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("shipping_amount", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("tax_amount", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("total_amount", sa.BigInteger(), nullable=False),
        sa.Column("refunded_amount", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("shipping_address", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("billing_address", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("discount_code", sa.Text(), nullable=True),
        sa.Column("customer_note", sa.Text(), nullable=True),
        sa.Column("internal_note", sa.Text(), nullable=True),
        sa.Column(
            "metadata",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "placed_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
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
            "fulfilment_status IN ('unfulfilled','partially_fulfilled','fulfilled','returned')",
            name=op.f("ck_orders_fulfilment_status_valid"),
        ),
        sa.CheckConstraint(
            "payment_status IN ('pending','authorised','paid','partially_refunded','refunded','failed')",
            name=op.f("ck_orders_payment_status_valid"),
        ),
        sa.CheckConstraint(
            "status IN ('pending','paid','processing','partially_fulfilled','fulfilled','delivered','cancelled','refunded','partially_refunded')",
            name=op.f("ck_orders_status_valid"),
        ),
        sa.CheckConstraint(
            "discount_amount >= 0", name=op.f("ck_orders_discount_amount_non_negative")
        ),
        sa.CheckConstraint(
            "refunded_amount <= total_amount", name=op.f("ck_orders_refund_within_total")
        ),
        sa.CheckConstraint(
            "refunded_amount >= 0", name=op.f("ck_orders_refunded_amount_non_negative")
        ),
        sa.CheckConstraint(
            "shipping_amount >= 0", name=op.f("ck_orders_shipping_amount_non_negative")
        ),
        sa.CheckConstraint(
            "subtotal_amount >= 0", name=op.f("ck_orders_subtotal_amount_non_negative")
        ),
        sa.CheckConstraint("tax_amount >= 0", name=op.f("ck_orders_tax_amount_non_negative")),
        sa.CheckConstraint(
            "total_amount = subtotal_amount - discount_amount + shipping_amount + tax_amount",
            name=op.f("ck_orders_order_totals_balance"),
        ),
        sa.CheckConstraint("total_amount >= 0", name=op.f("ck_orders_total_amount_non_negative")),
        sa.ForeignKeyConstraint(
            ["checkout_session_id"],
            ["checkout_sessions.id"],
            name=op.f("fk_orders_checkout_session_id_checkout_sessions"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_orders_user_id_users"), ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_orders")),
        sa.UniqueConstraint("checkout_session_id", name=op.f("uq_orders_checkout_session_id")),
        sa.UniqueConstraint("order_number", name=op.f("uq_orders_order_number")),
    )
    op.create_index(
        "idx_orders_email", "orders", ["email", sa.literal_column("placed_at DESC")], unique=False
    )
    op.create_index(
        "idx_orders_status", "orders", ["status", sa.literal_column("placed_at DESC")], unique=False
    )
    op.create_index(
        "idx_orders_unfulfilled",
        "orders",
        ["placed_at"],
        unique=False,
        postgresql_where=sa.text("fulfilment_status = 'unfulfilled' AND status = 'paid'"),
    )
    op.create_index(
        "idx_orders_user", "orders", ["user_id", sa.literal_column("placed_at DESC")], unique=False
    )
    op.create_table(
        "order_items",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        sa.Column("order_id", sa.Uuid(), nullable=False),
        sa.Column("variant_id", sa.Uuid(), nullable=True),
        sa.Column("product_title", sa.Text(), nullable=False),
        sa.Column("variant_title", sa.Text(), nullable=False),
        sa.Column("sku", sa.Text(), nullable=False),
        sa.Column("image_url", sa.Text(), nullable=True),
        sa.Column("unit_price_amount", sa.BigInteger(), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("discount_amount", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column(
            "tax_rate",
            sa.Numeric(precision=6, scale=4),
            server_default=sa.text("0"),
            nullable=False,
        ),
        sa.Column("tax_amount", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("total_amount", sa.BigInteger(), nullable=False),
        sa.Column("quantity_fulfilled", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("quantity_returned", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "discount_amount >= 0", name=op.f("ck_order_items_discount_amount_non_negative")
        ),
        sa.CheckConstraint("quantity > 0", name=op.f("ck_order_items_quantity_positive")),
        sa.CheckConstraint(
            "quantity_fulfilled <= quantity", name=op.f("ck_order_items_fulfilled_within_ordered")
        ),
        sa.CheckConstraint(
            "quantity_fulfilled >= 0", name=op.f("ck_order_items_quantity_fulfilled_non_negative")
        ),
        sa.CheckConstraint(
            "quantity_returned <= quantity_fulfilled",
            name=op.f("ck_order_items_returned_within_fulfilled"),
        ),
        sa.CheckConstraint(
            "quantity_returned >= 0", name=op.f("ck_order_items_quantity_returned_non_negative")
        ),
        sa.CheckConstraint("tax_amount >= 0", name=op.f("ck_order_items_tax_amount_non_negative")),
        sa.CheckConstraint(
            "total_amount >= 0", name=op.f("ck_order_items_total_amount_non_negative")
        ),
        sa.CheckConstraint(
            "unit_price_amount >= 0", name=op.f("ck_order_items_unit_price_amount_non_negative")
        ),
        sa.ForeignKeyConstraint(
            ["order_id"],
            ["orders.id"],
            name=op.f("fk_order_items_order_id_orders"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["variant_id"],
            ["product_variants.id"],
            name=op.f("fk_order_items_variant_id_product_variants"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_order_items")),
    )
    op.create_index("idx_order_items_order", "order_items", ["order_id"], unique=False)
    op.create_table(
        "order_events",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        sa.Column("order_id", sa.Uuid(), nullable=False),
        sa.Column("event_type", sa.Text(), nullable=False),
        sa.Column("from_status", sa.Text(), nullable=True),
        sa.Column("to_status", sa.Text(), nullable=True),
        sa.Column("actor_type", sa.Text(), nullable=False),
        sa.Column("actor_id", sa.Uuid(), nullable=True),
        sa.Column(
            "payload",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "actor_type IN ('customer','staff','system','webhook')",
            name=op.f("ck_order_events_actor_type_valid"),
        ),
        sa.ForeignKeyConstraint(
            ["order_id"],
            ["orders.id"],
            name=op.f("fk_order_events_order_id_orders"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_order_events")),
    )
    op.create_index("idx_order_events", "order_events", ["order_id", "created_at"], unique=False)
    op.create_table(
        "fulfilments",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        sa.Column("order_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.Text(), server_default="pending", nullable=False),
        sa.Column("carrier", sa.Text(), nullable=True),
        sa.Column("tracking_number", sa.Text(), nullable=True),
        sa.Column("tracking_url", sa.Text(), nullable=True),
        sa.Column("shipped_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('pending','in_transit','delivered','failed','cancelled')",
            name=op.f("ck_fulfilments_status_valid"),
        ),
        sa.ForeignKeyConstraint(
            ["order_id"],
            ["orders.id"],
            name=op.f("fk_fulfilments_order_id_orders"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_fulfilments")),
    )
    op.create_table(
        "fulfilment_items",
        sa.Column("fulfilment_id", sa.Uuid(), nullable=False),
        sa.Column("order_item_id", sa.Uuid(), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.CheckConstraint("quantity > 0", name=op.f("ck_fulfilment_items_quantity_positive")),
        sa.ForeignKeyConstraint(
            ["fulfilment_id"],
            ["fulfilments.id"],
            name=op.f("fk_fulfilment_items_fulfilment_id_fulfilments"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["order_item_id"],
            ["order_items.id"],
            name=op.f("fk_fulfilment_items_order_item_id_order_items"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("fulfilment_id", "order_item_id", name=op.f("pk_fulfilment_items")),
    )
    op.create_table(
        "returns",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        sa.Column("order_id", sa.Uuid(), nullable=False),
        sa.Column("rma_number", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), server_default="requested", nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("customer_note", sa.Text(), nullable=True),
        sa.Column("staff_note", sa.Text(), nullable=True),
        sa.Column("refund_amount", sa.BigInteger(), nullable=True),
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
            "status IN ('requested','approved','rejected','in_transit','received','refunded','closed')",
            name=op.f("ck_returns_status_valid"),
        ),
        sa.CheckConstraint(
            "refund_amount >= 0", name=op.f("ck_returns_refund_amount_non_negative")
        ),
        sa.ForeignKeyConstraint(
            ["order_id"], ["orders.id"], name=op.f("fk_returns_order_id_orders"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_returns")),
        sa.UniqueConstraint("rma_number", name=op.f("uq_returns_rma_number")),
    )
    op.create_table(
        "return_items",
        sa.Column("return_id", sa.Uuid(), nullable=False),
        sa.Column("order_item_id", sa.Uuid(), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("restock", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("condition", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "condition IN ('new','opened','damaged')", name=op.f("ck_return_items_condition_valid")
        ),
        sa.CheckConstraint("quantity > 0", name=op.f("ck_return_items_quantity_positive")),
        sa.ForeignKeyConstraint(
            ["order_item_id"],
            ["order_items.id"],
            name=op.f("fk_return_items_order_item_id_order_items"),
        ),
        sa.ForeignKeyConstraint(
            ["return_id"],
            ["returns.id"],
            name=op.f("fk_return_items_return_id_returns"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("return_id", "order_item_id", name=op.f("pk_return_items")),
    )
    op.create_table(
        "discount_redemptions",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        sa.Column("discount_id", sa.Uuid(), nullable=False),
        sa.Column("order_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column("amount", sa.BigInteger(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("amount >= 0", name=op.f("ck_discount_redemptions_amount_non_negative")),
        sa.ForeignKeyConstraint(
            ["discount_id"],
            ["discounts.id"],
            name=op.f("fk_discount_redemptions_discount_id_discounts"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["order_id"],
            ["orders.id"],
            name=op.f("fk_discount_redemptions_order_id_orders"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_discount_redemptions_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_discount_redemptions")),
        sa.UniqueConstraint(
            "discount_id", "order_id", name=op.f("uq_discount_redemptions_discount_id_order_id")
        ),
    )
    op.create_index(
        "idx_redemptions_user", "discount_redemptions", ["discount_id", "user_id"], unique=False
    )
    op.create_foreign_key(
        op.f("fk_reviews_order_id_orders"),
        "reviews",
        "orders",
        ["order_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(op.f("fk_reviews_order_id_orders"), "reviews", type_="foreignkey")
    op.drop_table("discount_redemptions")
    op.drop_table("return_items")
    op.drop_table("returns")
    op.drop_table("fulfilment_items")
    op.drop_table("fulfilments")
    op.drop_table("order_events")
    op.drop_table("order_items")
    op.drop_table("orders")
    op.drop_table("checkout_sessions")
