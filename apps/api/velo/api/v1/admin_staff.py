"""/admin/me, /admin/staff, /staff-invitations/accept — the team and what each may do.

``GET /admin/me`` answers "what may I do here?" for the admin's role-aware
menu: the role and its permissions, from the same table the guards use.
Managing staff needs ``staff:manage`` (owners). Accepting an invitation is
public: the token in the link is the credential.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Response, status
from pydantic import BaseModel, ConfigDict, EmailStr, StringConstraints

from velo.api.deps import (
    AdminDep,
    CurrentUserDep,
    SettingsDep,
    StaffManagerDep,
    StaffServiceDep,
)
from velo.domains.identity.permissions import permissions_for
from velo.domains.identity.staff import Invitation, StaffMember

router = APIRouter(tags=["admin: staff"])

StaffRole = Literal["fulfilment", "staff", "admin", "owner"]


class MeView(BaseModel):
    id: uuid.UUID
    email: str
    first_name: str | None
    last_name: str | None
    role: str
    permissions: list[str]
    store_currency: str


class MemberView(BaseModel):
    id: uuid.UUID
    email: str
    first_name: str | None
    last_name: str | None
    role: str
    status: str
    created_at: datetime

    @classmethod
    def of(cls, member: StaffMember) -> MemberView:
        return cls(
            id=member.id,
            email=member.email,
            first_name=member.first_name,
            last_name=member.last_name,
            role=member.role,
            status=member.status,
            created_at=member.created_at,
        )


class InvitationView(BaseModel):
    id: uuid.UUID
    email: str
    role: str
    expires_at: datetime
    created_at: datetime

    @classmethod
    def of(cls, invitation: Invitation) -> InvitationView:
        return cls(
            id=invitation.id,
            email=invitation.email,
            role=invitation.role,
            expires_at=invitation.expires_at,
            created_at=invitation.created_at,
        )


class TeamView(BaseModel):
    members: list[MemberView]
    invitations: list[InvitationView]


class Invite(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: EmailStr
    role: StaffRole


class SetRole(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: StaffRole | Literal["customer"]


class AcceptInvite(BaseModel):
    model_config = ConfigDict(extra="forbid")

    token: Annotated[str, StringConstraints(min_length=20, max_length=200)]
    password: Annotated[str, StringConstraints(max_length=128)] | None = None
    first_name: Annotated[str, StringConstraints(strip_whitespace=True, max_length=100)] | None = (
        None
    )
    last_name: Annotated[str, StringConstraints(strip_whitespace=True, max_length=100)] | None = (
        None
    )


@router.get("/admin/me", response_model=MeView, summary="Who I am here, and what I may do")
async def me(_: AdminDep, user: CurrentUserDep, settings: SettingsDep) -> MeView:
    return MeView(
        id=user.id,
        email=user.email,
        first_name=user.first_name,
        last_name=user.last_name,
        role=user.role,
        permissions=sorted(p.value for p in permissions_for(user.role)),
        store_currency=settings.currency,
    )


@router.get("/admin/staff", response_model=TeamView, summary="The team and open invitations")
async def team(_: StaffManagerDep, service: StaffServiceDep) -> TeamView:
    return TeamView(
        members=[MemberView.of(m) for m in await service.members()],
        invitations=[InvitationView.of(i) for i in await service.open_invitations()],
    )


@router.post(
    "/admin/staff/invite",
    response_model=InvitationView,
    status_code=status.HTTP_201_CREATED,
    summary="Email an invitation with a role",
)
async def invite(body: Invite, actor: StaffManagerDep, service: StaffServiceDep) -> InvitationView:
    return InvitationView.of(await service.invite(str(body.email), body.role, actor))


@router.delete(
    "/admin/staff/invitations/{invitation_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Withdraw an invitation",
)
async def withdraw(
    invitation_id: uuid.UUID, actor: StaffManagerDep, service: StaffServiceDep
) -> Response:
    await service.revoke_invitation(invitation_id, actor)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.patch(
    "/admin/staff/{user_id}",
    response_model=MemberView,
    summary="Change a role; 'customer' revokes admin access",
)
async def set_role(
    user_id: uuid.UUID, body: SetRole, actor: StaffManagerDep, service: StaffServiceDep
) -> MemberView:
    return MemberView.of(await service.set_role(user_id, body.role, actor))


@router.post(
    "/staff-invitations/accept",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Accept an invitation; then sign in",
)
async def accept(body: AcceptInvite, service: StaffServiceDep) -> Response:
    await service.accept(
        body.token, password=body.password, first_name=body.first_name, last_name=body.last_name
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
