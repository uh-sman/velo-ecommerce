"""Identity tables — DATA-MODEL.md §3.

Roles are a column, not a table: five fixed roles, with permissions mapped to
them in code (Phase 5). Sessions are refresh-token families (ADR-008); a
"session" in the account UI is one family.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CHAR, ForeignKey, Index, text
from sqlalchemy.dialects.postgresql import CITEXT, INET
from sqlalchemy.orm import Mapped, mapped_column

from velo.db.base import Base, HasCreatedAt, HasId, HasTimestamps, JsonObject, json_object, one_of

USER_ROLES = ("customer", "fulfilment", "staff", "admin", "owner")
USER_STATUSES = ("active", "suspended", "deleted")


class User(HasId, HasTimestamps, Base):
    __tablename__ = "users"

    email: Mapped[str] = mapped_column(CITEXT, unique=True)  # case-insensitive, no LOWER()
    password_hash: Mapped[str | None]  # NULL for OAuth-only accounts
    first_name: Mapped[str | None]
    last_name: Mapped[str | None]
    phone: Mapped[str | None]
    email_verified_at: Mapped[datetime | None]
    role: Mapped[str] = mapped_column(server_default="customer")
    status: Mapped[str] = mapped_column(server_default="active")
    failed_login_count: Mapped[int] = mapped_column(server_default=text("0"))
    locked_until: Mapped[datetime | None]
    marketing_opt_in: Mapped[bool] = mapped_column(server_default=text("false"))
    metadata_: Mapped[JsonObject] = json_object("metadata")

    __table_args__ = (
        one_of("role", *USER_ROLES),
        one_of("status", *USER_STATUSES),
        Index("idx_users_email_active", "email", postgresql_where=text("status = 'active'")),
    )


class RefreshToken(HasId, HasCreatedAt, Base):
    __tablename__ = "refresh_tokens"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    token_hash: Mapped[str] = mapped_column(unique=True)  # the hash, never the token
    family_id: Mapped[uuid.UUID]  # rotation lineage
    used_at: Mapped[datetime | None]  # set, then presented again = theft
    revoked_at: Mapped[datetime | None]
    expires_at: Mapped[datetime]
    user_agent: Mapped[str | None]
    ip_address: Mapped[str | None] = mapped_column(INET)

    __table_args__ = (
        Index(
            "idx_refresh_active",
            "user_id",
            postgresql_where=text("revoked_at IS NULL AND used_at IS NULL"),
        ),
        Index("idx_refresh_family", "family_id"),
    )


class Address(HasId, HasTimestamps, Base):
    __tablename__ = "addresses"

    # NULL = a guest checkout address.
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    label: Mapped[str | None]
    first_name: Mapped[str]
    last_name: Mapped[str]
    company: Mapped[str | None]
    line1: Mapped[str]
    line2: Mapped[str | None]
    city: Mapped[str]
    region: Mapped[str | None]
    postal_code: Mapped[str | None]
    country_code: Mapped[str] = mapped_column(CHAR(2))
    phone: Mapped[str | None]
    is_default_shipping: Mapped[bool] = mapped_column(server_default=text("false"))
    is_default_billing: Mapped[bool] = mapped_column(server_default=text("false"))

    __table_args__ = (
        Index("idx_addresses_user", "user_id"),
        # At most one default of each kind per user.
        Index(
            "uq_default_shipping",
            "user_id",
            unique=True,
            postgresql_where=text("is_default_shipping AND user_id IS NOT NULL"),
        ),
        Index(
            "uq_default_billing",
            "user_id",
            unique=True,
            postgresql_where=text("is_default_billing AND user_id IS NOT NULL"),
        ),
    )
