"""Checkout and payments: the priced snapshot, a payment before its intent, webhook retries.

PLANNING.md Phase 8.

- ``checkout_sessions.snapshot`` holds the priced lines, discounts, tax lines and
  shipping choice the totals were computed from. Order line items are copied
  from it, so an order records exactly what the customer was charged for.
- ``payments.provider_intent_id`` becomes nullable: the payment row is written
  *before* the provider is called (PAYMENTS-AND-CHECKOUT.md §3), so a crash
  mid-call leaves a record to recover from rather than money with no trace.
- ``payment_events`` gains retry bookkeeping and a dead-letter mark (§6.4).

Revision ID: 0012
Revises: 0011
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0012"
down_revision: str | None = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "checkout_sessions",
        sa.Column(
            "snapshot",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
    )
    op.create_index("idx_checkout_cart", "checkout_sessions", ["cart_id"], unique=False)

    op.alter_column("payments", "provider_intent_id", existing_type=sa.Text(), nullable=True)
    op.create_index("idx_payments_session", "payments", ["checkout_session_id"], unique=False)

    op.add_column(
        "payment_events",
        sa.Column("attempts", sa.Integer(), server_default=sa.text("0"), nullable=False),
    )
    op.add_column(
        "payment_events",
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "payment_events",
        sa.Column("dead_lettered_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "idx_payment_events_dead",
        "payment_events",
        ["dead_lettered_at"],
        unique=False,
        postgresql_where=sa.text("dead_lettered_at IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "idx_payment_events_dead",
        table_name="payment_events",
        postgresql_where=sa.text("dead_lettered_at IS NOT NULL"),
    )
    op.drop_column("payment_events", "dead_lettered_at")
    op.drop_column("payment_events", "next_attempt_at")
    op.drop_column("payment_events", "attempts")
    op.drop_index("idx_payments_session", table_name="payments")
    # Payments written before their intent cannot survive a return to NOT NULL.
    op.execute("DELETE FROM payments WHERE provider_intent_id IS NULL")
    op.alter_column("payments", "provider_intent_id", existing_type=sa.Text(), nullable=False)
    op.drop_index("idx_checkout_cart", table_name="checkout_sessions")
    op.drop_column("checkout_sessions", "snapshot")
