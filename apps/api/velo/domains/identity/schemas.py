"""Request and response bodies for /auth and /account.

Every request model forbids unknown fields (API-SPEC.md §3, rule 8): a typo in
a client is a loud 422, not a silently ignored field.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, EmailStr, Field, StringConstraints

from velo.domains.identity.permissions import permissions_for
from velo.domains.identity.repository import AddressRecord, UserRecord
from velo.domains.identity.service import ActiveSession

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
Line = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
ShortText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=100)]
# Length rules live in the service, which reports them as field errors a form can show.
Password = Annotated[str, StringConstraints(min_length=1, max_length=1024)]
CountryCode = Annotated[str, StringConstraints(pattern=r"^[A-Z]{2}$")]
Phone = Annotated[str, StringConstraints(strip_whitespace=True, max_length=32)]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ── Requests ──────────────────────────────────────────────────────────────────


class RegisterRequest(RequestModel):
    email: EmailStr
    password: Password
    first_name: Name | None = None
    last_name: Name | None = None
    marketing_opt_in: bool = False  # unchecked by default: pre-ticked consent is not consent


class LoginRequest(RequestModel):
    email: EmailStr
    password: Password


class TokenRequest(RequestModel):
    token: Annotated[str, StringConstraints(min_length=1, max_length=2048)]


class EmailRequest(RequestModel):
    email: EmailStr


class ResetPasswordRequest(RequestModel):
    token: Annotated[str, StringConstraints(min_length=1, max_length=2048)]
    password: Password


class ChangePasswordRequest(RequestModel):
    current_password: Password
    new_password: Password


class ProfileUpdateRequest(RequestModel):
    """PATCH: only the fields sent are changed."""

    first_name: Name | None = None
    last_name: Name | None = None
    phone: Phone | None = None
    marketing_opt_in: bool | None = None


class AddressFields(RequestModel):
    label: ShortText | None = None
    first_name: Name
    last_name: Name
    company: ShortText | None = None
    line1: Line
    line2: Line | None = None
    city: Name
    region: ShortText | None = None
    postal_code: Annotated[str, StringConstraints(strip_whitespace=True, max_length=20)] | None = (
        None
    )
    country_code: CountryCode
    phone: Phone | None = None
    is_default_shipping: bool = False
    is_default_billing: bool = False


class AddressUpdateRequest(RequestModel):
    """PATCH: only the fields sent are changed."""

    label: ShortText | None = None
    first_name: Name | None = None
    last_name: Name | None = None
    company: ShortText | None = None
    line1: Line | None = None
    line2: Line | None = None
    city: Name | None = None
    region: ShortText | None = None
    postal_code: Annotated[str, StringConstraints(strip_whitespace=True, max_length=20)] | None = (
        None
    )
    country_code: CountryCode | None = None
    phone: Phone | None = None
    is_default_shipping: bool | None = None
    is_default_billing: bool | None = None


# ── Responses ─────────────────────────────────────────────────────────────────


class UserResponse(BaseModel):
    id: uuid.UUID
    email: str
    first_name: str | None
    last_name: str | None
    phone: str | None
    role: str
    permissions: list[str] = Field(description="What this account may do; drives admin UI.")
    email_verified: bool
    marketing_opt_in: bool
    created_at: datetime

    @classmethod
    def of(cls, user: UserRecord) -> UserResponse:
        return cls(
            id=user.id,
            email=user.email,
            first_name=user.first_name,
            last_name=user.last_name,
            phone=user.phone,
            role=user.role,
            permissions=sorted(permissions_for(user.role)),
            email_verified=user.email_verified_at is not None,
            marketing_opt_in=user.marketing_opt_in,
            created_at=user.created_at,
        )


class AuthResponse(BaseModel):
    user: UserResponse
    access_expires_at: datetime


class CsrfResponse(BaseModel):
    csrf_token: str


class SessionResponse(BaseModel):
    id: uuid.UUID
    signed_in_at: datetime
    last_active_at: datetime
    user_agent: str | None
    ip_address: str | None
    is_current: bool

    @classmethod
    def of(cls, session: ActiveSession) -> SessionResponse:
        return cls(
            id=session.id,
            signed_in_at=session.signed_in_at,
            last_active_at=session.last_active_at,
            user_agent=session.user_agent,
            ip_address=session.ip_address,
            is_current=session.is_current,
        )


class AddressResponse(BaseModel):
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

    @classmethod
    def of(cls, address: AddressRecord) -> AddressResponse:
        return cls(
            id=address.id,
            label=address.label,
            first_name=address.first_name,
            last_name=address.last_name,
            company=address.company,
            line1=address.line1,
            line2=address.line2,
            city=address.city,
            region=address.region,
            postal_code=address.postal_code,
            country_code=address.country_code,
            phone=address.phone,
            is_default_shipping=address.is_default_shipping,
            is_default_billing=address.is_default_billing,
            created_at=address.created_at,
        )
