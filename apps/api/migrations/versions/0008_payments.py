"""Payments: payments, provider events, refunds, idempotency keys.

DATA-MODEL.md §8.

Revision ID: 0008
Revises: 0007
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "payments",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        sa.Column("order_id", sa.Uuid(), nullable=True),
        sa.Column("checkout_session_id", sa.Uuid(), nullable=False),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("provider_intent_id", sa.Text(), nullable=False),
        sa.Column("provider_charge_id", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), server_default="pending", nullable=False),
        sa.Column("amount", sa.BigInteger(), nullable=False),
        sa.Column("currency", sa.CHAR(length=3), nullable=False),
        sa.Column("amount_captured", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("amount_refunded", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("payment_method_type", sa.Text(), nullable=True),
        sa.Column("card_brand", sa.Text(), nullable=True),
        sa.Column("card_last4", sa.CHAR(length=4), nullable=True),
        sa.Column("failure_code", sa.Text(), nullable=True),
        sa.Column("failure_message", sa.Text(), nullable=True),
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
            "provider IN ('stripe','paystack','flutterwave')",
            name=op.f("ck_payments_provider_valid"),
        ),
        sa.CheckConstraint(
            "status IN ('pending','requires_action','processing','succeeded','failed','cancelled')",
            name=op.f("ck_payments_status_valid"),
        ),
        sa.CheckConstraint("amount > 0", name=op.f("ck_payments_amount_positive")),
        sa.CheckConstraint(
            "amount_captured <= amount", name=op.f("ck_payments_capture_within_amount")
        ),
        sa.CheckConstraint(
            "amount_captured >= 0", name=op.f("ck_payments_amount_captured_non_negative")
        ),
        sa.CheckConstraint(
            "amount_refunded <= amount_captured", name=op.f("ck_payments_refund_within_capture")
        ),
        sa.CheckConstraint(
            "amount_refunded >= 0", name=op.f("ck_payments_amount_refunded_non_negative")
        ),
        sa.ForeignKeyConstraint(
            ["checkout_session_id"],
            ["checkout_sessions.id"],
            name=op.f("fk_payments_checkout_session_id_checkout_sessions"),
        ),
        sa.ForeignKeyConstraint(
            ["order_id"],
            ["orders.id"],
            name=op.f("fk_payments_order_id_orders"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_payments")),
        sa.UniqueConstraint(
            "provider", "provider_intent_id", name=op.f("uq_payments_provider_provider_intent_id")
        ),
    )
    op.create_index("idx_payments_order", "payments", ["order_id"], unique=False)
    op.create_index(
        "idx_payments_pending",
        "payments",
        ["created_at"],
        unique=False,
        postgresql_where=sa.text("status IN ('pending','processing','requires_action')"),
    )
    op.create_table(
        "payment_events",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        sa.Column("payment_id", sa.Uuid(), nullable=True),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("provider_event_id", sa.Text(), nullable=False),
        sa.Column("event_type", sa.Text(), nullable=False),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("signature_verified", sa.Boolean(), nullable=False),
        sa.Column("processed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("processing_error", sa.Text(), nullable=True),
        sa.Column(
            "received_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["payment_id"],
            ["payments.id"],
            name=op.f("fk_payment_events_payment_id_payments"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_payment_events")),
        sa.UniqueConstraint(
            "provider",
            "provider_event_id",
            name=op.f("uq_payment_events_provider_provider_event_id"),
        ),
    )
    op.create_index(
        "idx_payment_events_unprocessed",
        "payment_events",
        ["received_at"],
        unique=False,
        postgresql_where=sa.text("processed_at IS NULL"),
    )
    op.create_table(
        "refunds",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        sa.Column("payment_id", sa.Uuid(), nullable=False),
        sa.Column("order_id", sa.Uuid(), nullable=False),
        sa.Column("return_id", sa.Uuid(), nullable=True),
        sa.Column("provider_refund_id", sa.Text(), nullable=True),
        sa.Column("amount", sa.BigInteger(), nullable=False),
        sa.Column("currency", sa.CHAR(length=3), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), server_default="pending", nullable=False),
        sa.Column("actor_id", sa.Uuid(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "reason IN ('requested_by_customer','duplicate','fraudulent','defective','other')",
            name=op.f("ck_refunds_reason_valid"),
        ),
        sa.CheckConstraint(
            "status IN ('pending','succeeded','failed','cancelled')",
            name=op.f("ck_refunds_status_valid"),
        ),
        sa.CheckConstraint("amount > 0", name=op.f("ck_refunds_amount_positive")),
        sa.ForeignKeyConstraint(["actor_id"], ["users.id"], name=op.f("fk_refunds_actor_id_users")),
        sa.ForeignKeyConstraint(
            ["order_id"], ["orders.id"], name=op.f("fk_refunds_order_id_orders")
        ),
        sa.ForeignKeyConstraint(
            ["payment_id"], ["payments.id"], name=op.f("fk_refunds_payment_id_payments")
        ),
        sa.ForeignKeyConstraint(
            ["return_id"], ["returns.id"], name=op.f("fk_refunds_return_id_returns")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_refunds")),
        sa.UniqueConstraint("provider_refund_id", name=op.f("uq_refunds_provider_refund_id")),
    )
    op.create_index("idx_refunds_order", "refunds", ["order_id"], unique=False)
    op.create_table(
        "idempotency_keys",
        sa.Column("key", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column("endpoint", sa.Text(), nullable=False),
        sa.Column("request_hash", sa.Text(), nullable=False),
        sa.Column("response_status", sa.Integer(), nullable=True),
        sa.Column("response_body", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("status", sa.Text(), server_default="in_flight", nullable=False),
        sa.Column(
            "expires_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now() + interval '24 hours'"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('in_flight','completed','failed')",
            name=op.f("ck_idempotency_keys_status_valid"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_idempotency_keys_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("key", name=op.f("pk_idempotency_keys")),
    )
    op.create_index("idx_idem_expiry", "idempotency_keys", ["expires_at"], unique=False)


def downgrade() -> None:
    op.drop_table("idempotency_keys")
    op.drop_table("refunds")
    op.drop_table("payment_events")
    op.drop_table("payments")
