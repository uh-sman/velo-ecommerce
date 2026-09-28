"""/auth — registration, sign-in, sessions, and recovery (API-SPEC.md §2).

HTTP only: parse, call the service, set or clear cookies, serialise. Every
decision is in ``velo/domains/identity/service.py``.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Request, Response, status

from velo.api.cookies import (
    CSRF_COOKIE,
    REFRESH_COOKIE,
    clear_session_cookies,
    set_csrf_cookie,
    set_session_cookies,
)
from velo.api.deps import (
    AuthServiceDep,
    ClientDep,
    CurrentUserDep,
    PrincipalDep,
    SettingsDep,
    access_token_from,
)
from velo.domains.identity.schemas import (
    AuthResponse,
    ChangePasswordRequest,
    CsrfResponse,
    EmailRequest,
    LoginRequest,
    ProfileUpdateRequest,
    RegisterRequest,
    ResetPasswordRequest,
    SessionResponse,
    TokenRequest,
    UserResponse,
)
from velo.domains.identity.service import IssuedSession

router = APIRouter(prefix="/auth", tags=["auth"])

NO_CONTENT = status.HTTP_204_NO_CONTENT


def _signed_in(response: Response, issued: IssuedSession, settings: SettingsDep) -> AuthResponse:
    set_session_cookies(response, issued, settings)
    return AuthResponse(
        user=UserResponse.of(issued.user),
        access_expires_at=datetime.now(UTC) + issued.access_ttl,
    )


@router.get("/csrf", response_model=CsrfResponse, summary="Get a CSRF token")
async def csrf(request: Request, response: Response, settings: SettingsDep) -> CsrfResponse:
    """The current token, issuing one if the browser has none yet."""
    token = request.cookies.get(CSRF_COOKIE) or set_csrf_cookie(response, settings)
    return CsrfResponse(csrf_token=token)


@router.post(
    "/register",
    response_model=AuthResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create an account and sign in",
)
async def register(
    body: RegisterRequest,
    response: Response,
    service: AuthServiceDep,
    client: ClientDep,
    settings: SettingsDep,
) -> AuthResponse:
    issued = await service.register(
        email=str(body.email),
        password=body.password,
        first_name=body.first_name,
        last_name=body.last_name,
        marketing_opt_in=body.marketing_opt_in,
        client=client,
    )
    return _signed_in(response, issued, settings)


@router.post("/login", response_model=AuthResponse, summary="Sign in")
async def login(
    body: LoginRequest,
    response: Response,
    service: AuthServiceDep,
    client: ClientDep,
    settings: SettingsDep,
) -> AuthResponse:
    issued = await service.login(email=str(body.email), password=body.password, client=client)
    return _signed_in(response, issued, settings)


@router.post("/refresh", response_model=AuthResponse, summary="Rotate the session")
async def refresh(
    request: Request,
    response: Response,
    service: AuthServiceDep,
    client: ClientDep,
    settings: SettingsDep,
) -> AuthResponse:
    issued = await service.refresh(request.cookies.get(REFRESH_COOKIE), client)
    return _signed_in(response, issued, settings)


@router.post("/logout", status_code=NO_CONTENT, summary="Sign out and revoke the session")
async def logout(
    request: Request, response: Response, service: AuthServiceDep, settings: SettingsDep
) -> None:
    await service.logout(access_token_from(request))
    clear_session_cookies(response, settings)


@router.post("/verify-email", status_code=NO_CONTENT, summary="Confirm an email address")
async def verify_email(body: TokenRequest, service: AuthServiceDep, client: ClientDep) -> None:
    await service.verify_email(body.token, client)


@router.post(
    "/resend-verification", status_code=NO_CONTENT, summary="Send the verification email again"
)
async def resend_verification(
    body: EmailRequest, service: AuthServiceDep, client: ClientDep
) -> None:
    await service.resend_verification(str(body.email), client)


@router.post(
    "/forgot-password",
    status_code=NO_CONTENT,
    summary="Email a password-reset link",
    description="Always 204, whether or not the account exists: no account enumeration.",
)
async def forgot_password(body: EmailRequest, service: AuthServiceDep, client: ClientDep) -> None:
    await service.forgot_password(str(body.email), client)


@router.post(
    "/reset-password", status_code=NO_CONTENT, summary="Set a new password from a reset link"
)
async def reset_password(
    body: ResetPasswordRequest,
    response: Response,
    service: AuthServiceDep,
    client: ClientDep,
    settings: SettingsDep,
) -> None:
    await service.reset_password(body.token, body.password, client)
    clear_session_cookies(response, settings)  # every session was revoked, this one included


@router.get("/me", response_model=UserResponse, summary="The signed-in user")
async def me(user: CurrentUserDep) -> UserResponse:
    return UserResponse.of(user)


@router.patch("/me", response_model=UserResponse, summary="Update profile")
async def update_me(
    body: ProfileUpdateRequest, principal: PrincipalDep, service: AuthServiceDep
) -> UserResponse:
    changes = body.model_dump(exclude_unset=True)
    if changes.get("marketing_opt_in") is None:
        changes.pop("marketing_opt_in", None)  # a boolean column cannot be "unset"
    user = await service.update_profile(principal.user_id, **changes)
    return UserResponse.of(user)


@router.post("/change-password", status_code=NO_CONTENT, summary="Change password")
async def change_password(
    body: ChangePasswordRequest, principal: PrincipalDep, service: AuthServiceDep
) -> None:
    await service.change_password(
        principal.user_id,
        principal.session_id,
        current_password=body.current_password,
        new_password=body.new_password,
    )


@router.get("/sessions", response_model=list[SessionResponse], summary="Active sessions")
async def sessions(principal: PrincipalDep, service: AuthServiceDep) -> list[SessionResponse]:
    active = await service.list_sessions(principal.user_id, principal.session_id)
    return [SessionResponse.of(session) for session in active]


@router.delete("/sessions/{session_id}", status_code=NO_CONTENT, summary="Revoke a session")
async def revoke_session(
    session_id: uuid.UUID, principal: PrincipalDep, service: AuthServiceDep
) -> None:
    await service.revoke_session(principal.user_id, session_id)
