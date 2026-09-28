"""Identity data access. Queries in, plain records out — no rules, no HTTP.

ORM instances stay in this module (ARCHITECTURE.md §3, rule 4): every method
returns a frozen record, so a service cannot lazy-load or mutate a row behind
the repository's back.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import and_, func, select, update
from sqlalchemy.dialects.postgresql import aggregate_order_by
from sqlalchemy.ext.asyncio import AsyncSession

from velo.domains.identity.models import Address, RefreshToken, User


@dataclass(frozen=True, slots=True)
class UserRecord:
    id: uuid.UUID
    email: str
    password_hash: str | None
    first_name: str | None
    last_name: str | None
    phone: str | None
    role: str
    status: str
    email_verified_at: datetime | None
    failed_login_count: int
    locked_until: datetime | None
    marketing_opt_in: bool
    created_at: datetime


@dataclass(frozen=True, slots=True)
class RefreshTokenRecord:
    id: uuid.UUID
    user_id: uuid.UUID
    family_id: uuid.UUID
    used_at: datetime | None
    revoked_at: datetime | None
    expires_at: datetime


@dataclass(frozen=True, slots=True)
class SessionRecord:
    family_id: uuid.UUID
    signed_in_at: datetime
    last_active_at: datetime
    user_agent: str | None
    ip_address: str | None


@dataclass(frozen=True, slots=True)
class AddressRecord:
    id: uuid.UUID
    label: str | None
    first_name: str
    last_name: str
    company: str | None
    line1: str
    line2: str | None
    city: str
    region: str | None
    postal_code: str | None
    country_code: str
    phone: str | None
    is_default_shipping: bool
    is_default_billing: bool
    created_at: datetime


def _user(row: User) -> UserRecord:
    return UserRecord(
        id=row.id,
        email=row.email,
        password_hash=row.password_hash,
        first_name=row.first_name,
        last_name=row.last_name,
        phone=row.phone,
        role=row.role,
        status=row.status,
        email_verified_at=row.email_verified_at,
        failed_login_count=row.failed_login_count,
        locked_until=row.locked_until,
        marketing_opt_in=row.marketing_opt_in,
        created_at=row.created_at,
    )


def _address(row: Address) -> AddressRecord:
    return AddressRecord(
        id=row.id,
        label=row.label,
        first_name=row.first_name,
        last_name=row.last_name,
        company=row.company,
        line1=row.line1,
        line2=row.line2,
        city=row.city,
        region=row.region,
        postal_code=row.postal_code,
        country_code=row.country_code,
        phone=row.phone,
        is_default_shipping=row.is_default_shipping,
        is_default_billing=row.is_default_billing,
        created_at=row.created_at,
    )


class UserRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get_by_id(self, user_id: uuid.UUID) -> UserRecord | None:
        row = await self._session.get(User, user_id)
        return _user(row) if row else None

    async def get_by_email(self, email: str) -> UserRecord | None:
        # email is CITEXT: the comparison is case-insensitive in the database.
        row = await self._session.scalar(select(User).where(User.email == email))
        return _user(row) if row else None

    async def lock_for_update(self, user_id: uuid.UUID) -> UserRecord | None:
        """Serialise concurrent logins for one account (failed-attempt counting)."""
        row = await self._session.scalar(select(User).where(User.id == user_id).with_for_update())
        return _user(row) if row else None

    async def create(
        self,
        *,
        email: str,
        password_hash: str,
        first_name: str | None,
        last_name: str | None,
        marketing_opt_in: bool,
    ) -> UserRecord:
        row = User(
            email=email,
            password_hash=password_hash,
            first_name=first_name,
            last_name=last_name,
            marketing_opt_in=marketing_opt_in,
        )
        self._session.add(row)
        await self._session.flush()
        return _user(row)

    async def increment_failed_logins(self, user_id: uuid.UUID) -> int:
        count = await self._session.scalar(
            update(User)
            .where(User.id == user_id)
            .values(failed_login_count=User.failed_login_count + 1)
            .returning(User.failed_login_count)
        )
        return int(count or 0)

    async def update(self, user_id: uuid.UUID, **values: Any) -> UserRecord:
        await self._session.execute(update(User).where(User.id == user_id).values(**values))
        row = await self._session.get(User, user_id, populate_existing=True)
        assert row is not None
        return _user(row)


class RefreshTokenRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def create(
        self,
        *,
        user_id: uuid.UUID,
        token_hash: str,
        family_id: uuid.UUID,
        expires_at: datetime,
        user_agent: str | None,
        ip_address: str | None,
    ) -> None:
        self._session.add(
            RefreshToken(
                user_id=user_id,
                token_hash=token_hash,
                family_id=family_id,
                expires_at=expires_at,
                user_agent=user_agent,
                ip_address=ip_address,
            )
        )
        await self._session.flush()

    async def get_by_hash_for_update(self, token_hash: str) -> RefreshTokenRecord | None:
        """Row-locked, so two concurrent refreshes with one token serialise here."""
        row = await self._session.scalar(
            select(RefreshToken).where(RefreshToken.token_hash == token_hash).with_for_update()
        )
        if row is None:
            return None
        return RefreshTokenRecord(
            id=row.id,
            user_id=row.user_id,
            family_id=row.family_id,
            used_at=row.used_at,
            revoked_at=row.revoked_at,
            expires_at=row.expires_at,
        )

    async def mark_used(self, token_id: uuid.UUID, at: datetime) -> None:
        await self._session.execute(
            update(RefreshToken).where(RefreshToken.id == token_id).values(used_at=at)
        )

    async def revoke_family(self, family_id: uuid.UUID, at: datetime) -> int:
        result = await self._session.execute(
            update(RefreshToken)
            .where(RefreshToken.family_id == family_id, RefreshToken.revoked_at.is_(None))
            .values(revoked_at=at)
        )
        return int(getattr(result, "rowcount", 0) or 0)

    async def revoke_all_for_user(
        self, user_id: uuid.UUID, at: datetime, *, except_family: uuid.UUID | None = None
    ) -> None:
        conditions = [RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None)]
        if except_family is not None:
            conditions.append(RefreshToken.family_id != except_family)
        await self._session.execute(update(RefreshToken).where(*conditions).values(revoked_at=at))

    async def family_owner(self, family_id: uuid.UUID) -> uuid.UUID | None:
        owner: uuid.UUID | None = await self._session.scalar(
            select(RefreshToken.user_id).where(RefreshToken.family_id == family_id).limit(1)
        )
        return owner

    async def list_active_sessions(self, user_id: uuid.UUID, now: datetime) -> list[SessionRecord]:
        """One row per token family that still holds a usable token."""
        live = and_(
            RefreshToken.revoked_at.is_(None),
            RefreshToken.used_at.is_(None),
            RefreshToken.expires_at > now,
        )
        newest_first = RefreshToken.created_at.desc()
        last_active = func.max(RefreshToken.created_at)
        query = (
            select(
                RefreshToken.family_id,
                func.min(RefreshToken.created_at),
                last_active,
                func.array_agg(aggregate_order_by(RefreshToken.user_agent, newest_first))[1],
                func.array_agg(aggregate_order_by(RefreshToken.ip_address, newest_first))[1],
            )
            .where(RefreshToken.user_id == user_id)
            .group_by(RefreshToken.family_id)
            .having(func.bool_or(live))
            .order_by(last_active.desc())
        )
        rows = (await self._session.execute(query)).all()
        return [
            SessionRecord(
                family_id=family_id,
                signed_in_at=signed_in_at,
                last_active_at=last_active_at,
                user_agent=user_agent,
                ip_address=str(ip) if ip is not None else None,
            )
            for family_id, signed_in_at, last_active_at, user_agent, ip in rows
        ]


class AddressRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def list(self, user_id: uuid.UUID) -> list[AddressRecord]:
        rows = await self._session.scalars(
            select(Address)
            .where(Address.user_id == user_id)
            .order_by(
                Address.is_default_shipping.desc(),
                Address.is_default_billing.desc(),
                Address.created_at.desc(),
            )
        )
        return [_address(row) for row in rows]

    async def count(self, user_id: uuid.UUID) -> int:
        return int(
            await self._session.scalar(
                select(func.count()).select_from(Address).where(Address.user_id == user_id)
            )
            or 0
        )

    async def get(self, user_id: uuid.UUID, address_id: uuid.UUID) -> AddressRecord | None:
        """Scoped to the owner: another user's address is simply not found."""
        row = await self._session.scalar(
            select(Address).where(Address.id == address_id, Address.user_id == user_id)
        )
        return _address(row) if row else None

    async def create(self, user_id: uuid.UUID, **values: Any) -> AddressRecord:
        row = Address(user_id=user_id, **values)
        self._session.add(row)
        await self._session.flush()
        return _address(row)

    async def update(
        self, user_id: uuid.UUID, address_id: uuid.UUID, **values: Any
    ) -> AddressRecord:
        await self._session.execute(
            update(Address)
            .where(Address.id == address_id, Address.user_id == user_id)
            .values(**values)
        )
        row = await self._session.get(Address, address_id, populate_existing=True)
        assert row is not None
        return _address(row)

    async def clear_default(self, user_id: uuid.UUID, column: str) -> None:
        """Unset one kind of default, so another address can take it."""
        await self._session.execute(
            update(Address)
            .where(Address.user_id == user_id, getattr(Address, column).is_(True))
            .values({column: False})
        )

    async def delete(self, user_id: uuid.UUID, address_id: uuid.UUID) -> None:
        row = await self._session.scalar(
            select(Address).where(Address.id == address_id, Address.user_id == user_id)
        )
        if row is not None:
            await self._session.delete(row)
            await self._session.flush()
