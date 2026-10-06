"""Indexes the hot-query review asked for (PLANNING.md Phase 14, docs/PERFORMANCE.md).

``idx_orders_placed`` serves the admin order list's default sort, newest
first with the id as tiebreak, so a page reads its rows from the index
instead of sorting every order.

``idx_checkout_expiry`` is narrowed to the statuses the checkout sweeper
actually sweeps. Its old predicate excluded ``failed``, which the sweeper
does sweep, so Postgres could not prove the sweeper's query implied it and
scanned every checkout session ever created.

Revision ID: 0018
Revises: 0017
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0018"
down_revision: str | None = "0017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index("idx_orders_placed", "orders", [sa.text("placed_at DESC"), sa.text("id DESC")])
    op.drop_index("idx_checkout_expiry", table_name="checkout_sessions")
    op.create_index(
        "idx_checkout_expiry",
        "checkout_sessions",
        ["expires_at"],
        postgresql_where=sa.text("status IN ('initiated','address_set','shipping_set','failed')"),
    )


def downgrade() -> None:
    op.drop_index("idx_checkout_expiry", table_name="checkout_sessions")
    op.create_index(
        "idx_checkout_expiry",
        "checkout_sessions",
        ["expires_at"],
        postgresql_where=sa.text("status NOT IN ('confirmed','failed','expired')"),
    )
    op.drop_index("idx_orders_placed", table_name="orders")
