"""Pricing: buy-X-get-Y and customer segments on discounts; applied code and seen price on carts.

PLANNING.md Phase 7. ``cart_items.seen_price_amount`` is the price last shown
to the customer, kept only to warn when it changes; the cart is always priced
from ``product_variants``.

Revision ID: 0011
Revises: 0010
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("discounts", sa.Column("buy_quantity", sa.Integer(), nullable=True))
    op.add_column("discounts", sa.Column("get_quantity", sa.Integer(), nullable=True))
    op.add_column(
        "discounts",
        sa.Column("customer_segment", sa.Text(), server_default="all", nullable=False),
    )
    op.create_check_constraint(
        op.f("ck_discounts_customer_segment_valid"),
        "discounts",
        "customer_segment IN ('all','returning','subscribers','staff')",
    )
    op.create_check_constraint(
        op.f("ck_discounts_percent_in_range"),
        "discounts",
        "type NOT IN ('percentage', 'buy_x_get_y') OR (value > 0 AND value <= 100)",
    )
    op.create_check_constraint(
        op.f("ck_discounts_fixed_amount_has_currency"),
        "discounts",
        "type <> 'fixed_amount' OR (value > 0 AND currency IS NOT NULL)",
    )
    op.create_check_constraint(
        op.f("ck_discounts_buy_x_get_y_quantities"),
        "discounts",
        "type <> 'buy_x_get_y' OR (buy_quantity >= 1 AND get_quantity >= 1)",
    )
    op.add_column("carts", sa.Column("discount_code", postgresql.CITEXT(), nullable=True))
    op.add_column("cart_items", sa.Column("seen_price_amount", sa.BigInteger(), nullable=True))


def downgrade() -> None:
    op.drop_column("cart_items", "seen_price_amount")
    op.drop_column("carts", "discount_code")
    for name in (
        "buy_x_get_y_quantities",
        "fixed_amount_has_currency",
        "percent_in_range",
        "customer_segment_valid",
    ):
        op.drop_constraint(op.f(f"ck_discounts_{name}"), "discounts", type_="check")
    op.drop_column("discounts", "customer_segment")
    op.drop_column("discounts", "get_quantity")
    op.drop_column("discounts", "buy_quantity")
