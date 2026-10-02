"""Staff: who can sign in to the admin, with which role (PLANNING.md Phase 11).

- **Invite.** An owner names an email and a role; the invitee gets a link with
  a single-use token (only its hash is stored) valid for 7 days. A new email
  sets a password when accepting; an existing customer account is upgraded in
  place and keeps its password.
- **Change role / revoke.** Revoking makes the account a customer again and
  ends every session it has, so an admin cookie in someone's browser stops
  working at its next refresh. An owner cannot demote themselves, and the last
  owner can never be removed — the store must always have someone who can
  manage staff.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from velo.core.config import Settings
from velo.core.email import EmailMessage, Mailer
from velo.core.errors import ConflictError, FieldError, NotFoundError, ValidationError
from velo.core.security import hash_token, new_opaque_token
from velo.domains.identity.models import StaffInvitation, User
from velo.domains.identity.passwords import hash_password
from velo.domains.identity.permissions import Role
from velo.domains.identity.repository import RefreshTokenRepository
from velo.domains.identity.service import password_problems
from velo.domains.platform.events import Actor, record_audit
from velo.domains.platform.settings import SettingsService
from velo.emails.render import render

INVITE_TTL = timedelta(days=7)
STAFF_ROLES = ("fulfilment", "staff", "admin", "owner")


class InvitationInvalidError(ValidationError):
    slug = "invitation-invalid"
    title = "This invitation link is not valid"


class LastOwnerError(ConflictError):
    slug = "last-owner"
    title = "The store needs at least one owner"


@dataclass(frozen=True, slots=True)
class StaffMember:
    id: uuid.UUID
    email: str
    first_name: str | None
    last_name: str | None
    role: str
    status: str
    created_at: datetime


@dataclass(frozen=True, slots=True)
class Invitation:
    id: uuid.UUID
    email: str
    role: str
    expires_at: datetime
    created_at: datetime


def _now() -> datetime:
    return datetime.now(UTC)


class StaffService:
    def __init__(self, session: AsyncSession, settings: Settings, mailer: Mailer) -> None:
        self._session = session
        self._settings = settings
        self._mailer = mailer
        self._tokens = RefreshTokenRepository(session)

    async def members(self) -> list[StaffMember]:
        rows = (
            await self._session.scalars(
                select(User).where(User.role.in_(STAFF_ROLES)).order_by(User.created_at)
            )
        ).all()
        return [
            StaffMember(
                id=row.id,
                email=row.email,
                first_name=row.first_name,
                last_name=row.last_name,
                role=row.role,
                status=row.status,
                created_at=row.created_at,
            )
            for row in rows
        ]

    async def open_invitations(self) -> list[Invitation]:
        rows = (
            await self._session.scalars(
                select(StaffInvitation)
                .where(
                    StaffInvitation.accepted_at.is_(None),
                    StaffInvitation.revoked_at.is_(None),
                    StaffInvitation.expires_at > _now(),
                )
                .order_by(StaffInvitation.created_at.desc())
            )
        ).all()
        return [
            Invitation(
                id=row.id,
                email=row.email,
                role=row.role,
                expires_at=row.expires_at,
                created_at=row.created_at,
            )
            for row in rows
        ]

    async def invite(self, email: str, role: str, actor: Actor) -> Invitation:
        if role not in STAFF_ROLES:
            raise ValidationError(f"Role must be one of: {', '.join(STAFF_ROLES)}.")
        existing = await self._session.scalar(select(User).where(User.email == email))
        if existing is not None and existing.role in STAFF_ROLES:
            raise ConflictError(f"{email} is already on the team, as {existing.role}.")
        # A new invitation replaces any still open for the same address.
        await self._session.execute(
            update(StaffInvitation)
            .where(
                StaffInvitation.email == email,
                StaffInvitation.accepted_at.is_(None),
                StaffInvitation.revoked_at.is_(None),
            )
            .values(revoked_at=_now())
        )
        token = new_opaque_token()
        row = StaffInvitation(
            email=email,
            role=role,
            token_hash=hash_token(token),
            invited_by=actor.user_id,
            expires_at=_now() + INVITE_TTL,
        )
        self._session.add(row)
        await self._session.flush()
        record_audit(
            self._session,
            actor,
            "staff.invited",
            "staff_invitation",
            row.id,
            {
                "email": email,
                "role": role,
            },
        )
        await self._session.commit()
        link = f"{self._settings.admin_url}/accept-invite?token={token}"
        values = await SettingsService(self._session, self._settings).all()
        rendered = render(
            "staff_invite",
            {"inviter": actor.email or "A colleague", "role": role, "invite_url": link},
            store=values["store"],
            texts=values["emails"],
        )
        await self._mailer.send(
            EmailMessage(to=email, subject=rendered.subject, text=rendered.text, html=rendered.html)
        )
        return Invitation(
            id=row.id, email=email, role=role, expires_at=row.expires_at, created_at=row.created_at
        )

    async def revoke_invitation(self, invitation_id: uuid.UUID, actor: Actor) -> None:
        row = await self._session.get(StaffInvitation, invitation_id, with_for_update=True)
        if row is None or row.accepted_at is not None or row.revoked_at is not None:
            raise NotFoundError("No open invitation with that id.")
        row.revoked_at = _now()
        record_audit(
            self._session,
            actor,
            "staff.invitation_revoked",
            "staff_invitation",
            row.id,
            {"email": row.email},
        )
        await self._session.commit()

    async def accept(
        self,
        token: str,
        *,
        password: str | None,
        first_name: str | None,
        last_name: str | None,
    ) -> uuid.UUID:
        """Redeem an invitation. Returns the user id; the caller signs them in."""
        row = await self._session.scalar(
            select(StaffInvitation)
            .where(StaffInvitation.token_hash == hash_token(token))
            .with_for_update()
        )
        if (
            row is None
            or row.accepted_at is not None
            or row.revoked_at is not None
            or row.expires_at <= _now()
        ):
            raise InvitationInvalidError(
                "This invitation has expired, been used, or been withdrawn. Ask for a new one."
            )
        user = await self._session.scalar(
            select(User).where(User.email == row.email).with_for_update()
        )
        if user is None:
            if not password:
                raise ValidationError(
                    "Choose a password for your new account.",
                    errors=[
                        FieldError(field="password", code="missing", message="Choose a password.")
                    ],
                )
            if problems := password_problems(password, row.email):
                raise ValidationError("Choose a different password.", errors=problems)
            user = User(
                email=row.email,
                password_hash=hash_password(password),
                first_name=first_name,
                last_name=last_name,
                role=row.role,
                # The invitation reached this inbox: that verifies it.
                email_verified_at=_now(),
            )
            self._session.add(user)
            await self._session.flush()
        else:
            user.role = row.role
            user.email_verified_at = user.email_verified_at or _now()
            if first_name and not user.first_name:
                user.first_name = first_name
            if last_name and not user.last_name:
                user.last_name = last_name
            # Sessions carry the role: end the customer ones so the next sign-in has it.
            await self._tokens.revoke_all_for_user(user.id, _now())
        row.accepted_at = _now()
        record_audit(
            self._session,
            Actor(user_id=user.id, email=user.email),
            "staff.joined",
            "user",
            user.id,
            {"role": row.role},
        )
        await self._session.commit()
        return user.id

    async def set_role(self, user_id: uuid.UUID, role: str, actor: Actor) -> StaffMember:
        if role not in (*STAFF_ROLES, "customer"):
            raise ValidationError("Unknown role.")
        user = await self._session.get(User, user_id, with_for_update=True)
        if user is None or user.role not in STAFF_ROLES:
            raise NotFoundError("No staff member with that id.")
        if user.role == role:
            return self._member(user)
        if user.role == Role.OWNER:
            if user_id == actor.user_id:
                raise LastOwnerError("Ask another owner to change your role.")
            owners = await self._session.scalar(
                select(func.count()).select_from(User).where(User.role == Role.OWNER)
            )
            if int(owners or 0) <= 1:
                raise LastOwnerError("Make someone else an owner first.")
        before = user.role
        user.role = role
        # The role lives in the access token: end every session so it takes effect.
        await self._tokens.revoke_all_for_user(user.id, _now())
        record_audit(
            self._session,
            actor,
            "staff.revoked" if role == "customer" else "staff.role_changed",
            "user",
            user.id,
            {"role": {"from": before, "to": role}, "email": user.email},
        )
        await self._session.commit()
        return self._member(user)

    @staticmethod
    def _member(user: User) -> StaffMember:
        return StaffMember(
            id=user.id,
            email=user.email,
            first_name=user.first_name,
            last_name=user.last_name,
            role=user.role,
            status=user.status,
            created_at=user.created_at,
        )
