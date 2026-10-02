"""Email delivery and job failures: sent emails, preferences, cart reminders, the job DLQ.

PLANNING.md Phase 12.

- ``sent_emails`` logs every customer email and, through a unique
  ``dedupe_key``, makes each customer-facing event send exactly once. The
  provider's delivery webhook updates its status.
- ``email_preferences`` holds opt-outs by address, so a guest can unsubscribe.
- ``cart_reminders`` tracks the abandoned-cart sequence per cart.
- ``job_failures`` keeps background jobs that exhausted their retries, for
  alerting and replay.

Revision ID: 0016
Revises: 0015
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NOW = sa.text("now()")


def upgrade() -> None:
    op.create_table(
        "sent_emails",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("to_email", postgresql.CITEXT(), nullable=False),
        sa.Column("subject", sa.Text(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column("dedupe_key", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), server_default="queued", nullable=False),
        sa.Column("skip_reason", sa.Text(), nullable=True),
        sa.Column("provider", sa.Text(), nullable=True),
        sa.Column("provider_message_id", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("bounced_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.CheckConstraint(
            "status IN ('queued','sent','delivered','bounced','complained','failed','skipped')",
            name=op.f("ck_sent_emails_status_valid"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_sent_emails_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_sent_emails")),
        sa.UniqueConstraint("dedupe_key", name=op.f("uq_sent_emails_dedupe_key")),
        sa.UniqueConstraint("provider_message_id", name=op.f("uq_sent_emails_provider_message_id")),
    )
    op.create_index(
        "idx_sent_emails_to", "sent_emails", ["to_email", sa.text("created_at DESC")], unique=False
    )

    op.create_table(
        "email_preferences",
        sa.Column("email", postgresql.CITEXT(), nullable=False),
        sa.Column("cart_reminders", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.PrimaryKeyConstraint("email", name=op.f("pk_email_preferences")),
    )

    op.create_table(
        "cart_reminders",
        sa.Column("cart_id", sa.Uuid(), nullable=False),
        sa.Column("email", postgresql.CITEXT(), nullable=False),
        sa.Column("step", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("activity_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["cart_id"],
            ["carts.id"],
            name=op.f("fk_cart_reminders_cart_id_carts"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("cart_id", name=op.f("pk_cart_reminders")),
    )

    op.create_table(
        "job_failures",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        sa.Column("job", sa.Text(), nullable=False),
        sa.Column("args", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("error", sa.Text(), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("status", sa.Text(), server_default="dead", nullable=False),
        sa.Column("replayed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=_NOW, nullable=False),
        sa.CheckConstraint(
            "status IN ('dead','replayed')", name=op.f("ck_job_failures_status_valid")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_job_failures")),
    )
    op.create_index(
        "idx_job_failures_dead",
        "job_failures",
        ["created_at"],
        unique=False,
        postgresql_where=sa.text("status = 'dead'"),
    )


def downgrade() -> None:
    op.drop_index(
        "idx_job_failures_dead",
        table_name="job_failures",
        postgresql_where=sa.text("status = 'dead'"),
    )
    op.drop_table("job_failures")
    op.drop_table("cart_reminders")
    op.drop_table("email_preferences")
    op.drop_index("idx_sent_emails_to", table_name="sent_emails")
    op.drop_table("sent_emails")
