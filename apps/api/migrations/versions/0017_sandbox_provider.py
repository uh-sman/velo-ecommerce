"""Allow the sandbox payment provider (PLANNING.md Phase 13).

E2E and load tests pay through ``payments/sandbox.py``. Its payments are
real rows, so the provider check has to admit it; configuration, not the
schema, keeps it out of production (``payment_sandbox`` is refused there).

Revision ID: 0017
Revises: 0016
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0017"
down_revision: str | None = "0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(op.f("ck_payments_provider_valid"), "payments", type_="check")
    op.create_check_constraint(
        op.f("ck_payments_provider_valid"),
        "payments",
        "provider IN ('stripe','paystack','flutterwave','sandbox')",
    )


def downgrade() -> None:
    sandbox = "SELECT id FROM payments WHERE provider = 'sandbox'"
    refunds = f"SELECT id FROM refunds WHERE payment_id IN ({sandbox})"  # noqa: S608
    op.execute(f"DELETE FROM refund_items WHERE refund_id IN ({refunds})")  # noqa: S608
    op.execute(f"DELETE FROM refunds WHERE payment_id IN ({sandbox})")  # noqa: S608
    op.execute("DELETE FROM payments WHERE provider = 'sandbox'")
    op.drop_constraint(op.f("ck_payments_provider_valid"), "payments", type_="check")
    op.create_check_constraint(
        op.f("ck_payments_provider_valid"),
        "payments",
        "provider IN ('stripe','paystack','flutterwave')",
    )
