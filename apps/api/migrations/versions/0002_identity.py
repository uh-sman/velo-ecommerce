"""Identity: users, refresh tokens, addresses.

DATA-MODEL.md §3.

Revision ID: 0002
Revises: 0001
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        sa.Column("email", postgresql.CITEXT(), nullable=False),
        sa.Column("password_hash", sa.Text(), nullable=True),
        sa.Column("first_name", sa.Text(), nullable=True),
        sa.Column("last_name", sa.Text(), nullable=True),
        sa.Column("phone", sa.Text(), nullable=True),
        sa.Column("email_verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("role", sa.Text(), server_default="customer", nullable=False),
        sa.Column("status", sa.Text(), server_default="active", nullable=False),
        sa.Column("failed_login_count", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("locked_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "marketing_opt_in", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
        sa.Column(
            "metadata",
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
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "role IN ('customer','fulfilment','staff','admin','owner')",
            name=op.f("ck_users_role_valid"),
        ),
        sa.CheckConstraint(
            "status IN ('active','suspended','deleted')", name=op.f("ck_users_status_valid")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_users")),
        sa.UniqueConstraint("email", name=op.f("uq_users_email")),
    )
    op.create_index(
        "idx_users_email_active",
        "users",
        ["email"],
        unique=False,
        postgresql_where=sa.text("status = 'active'"),
    )
    op.create_table(
        "refresh_tokens",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.Text(), nullable=False),
        sa.Column("family_id", sa.Uuid(), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("user_agent", sa.Text(), nullable=True),
        sa.Column("ip_address", postgresql.INET(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_refresh_tokens_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_refresh_tokens")),
        sa.UniqueConstraint("token_hash", name=op.f("uq_refresh_tokens_token_hash")),
    )
    op.create_index(
        "idx_refresh_active",
        "refresh_tokens",
        ["user_id"],
        unique=False,
        postgresql_where=sa.text("revoked_at IS NULL AND used_at IS NULL"),
    )
    op.create_index("idx_refresh_family", "refresh_tokens", ["family_id"], unique=False)
    op.create_table(
        "addresses",
        sa.Column("id", sa.Uuid(), server_default=sa.text("uuidv7()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column("label", sa.Text(), nullable=True),
        sa.Column("first_name", sa.Text(), nullable=False),
        sa.Column("last_name", sa.Text(), nullable=False),
        sa.Column("company", sa.Text(), nullable=True),
        sa.Column("line1", sa.Text(), nullable=False),
        sa.Column("line2", sa.Text(), nullable=True),
        sa.Column("city", sa.Text(), nullable=False),
        sa.Column("region", sa.Text(), nullable=True),
        sa.Column("postal_code", sa.Text(), nullable=True),
        sa.Column("country_code", sa.CHAR(length=2), nullable=False),
        sa.Column("phone", sa.Text(), nullable=True),
        sa.Column(
            "is_default_shipping", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
        sa.Column(
            "is_default_billing", sa.Boolean(), server_default=sa.text("false"), nullable=False
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
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_addresses_user_id_users"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_addresses")),
    )
    op.create_index("idx_addresses_user", "addresses", ["user_id"], unique=False)
    op.create_index(
        "uq_default_billing",
        "addresses",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("is_default_billing AND user_id IS NOT NULL"),
    )
    op.create_index(
        "uq_default_shipping",
        "addresses",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("is_default_shipping AND user_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_table("addresses")
    op.drop_table("refresh_tokens")
    op.drop_table("users")
