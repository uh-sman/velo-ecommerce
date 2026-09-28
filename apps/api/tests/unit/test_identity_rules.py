"""Identity rules that need no database: password policy, breach parsing, RBAC."""

from __future__ import annotations

import hashlib
import itertools
import uuid

import httpx
import pytest
from fastapi import Depends, FastAPI
from httpx import ASGITransport, AsyncClient

from velo.api.deps import Principal, get_current_principal, require_permission
from velo.core.errors import register_exception_handlers
from velo.domains.identity.breach import PwnedPasswordsChecker
from velo.domains.identity.permissions import (
    ROLE_PERMISSIONS,
    Permission,
    Role,
    has_permission,
    is_staff,
    permissions_for,
)
from velo.domains.identity.service import password_problems

# ── Password policy ───────────────────────────────────────────────────────────


def test_a_long_passphrase_passes_with_no_composition_rules() -> None:
    assert password_problems("correct horse battery staple") == []


@pytest.mark.parametrize(
    ("password", "code"),
    [
        ("nine-char", "too_short"),
        ("x" * 129, "too_long"),
        ("casey@example.com", "matches_email"),
        ("Casey", "too_short"),
    ],
)
def test_policy_violations(password: str, code: str) -> None:
    codes = [problem.code for problem in password_problems(password, "casey@example.com")]
    assert code in codes


def test_the_local_part_of_the_email_is_refused_too() -> None:
    codes = [p.code for p in password_problems("caseyjones1", "caseyjones1@example.com")]
    assert "matches_email" in codes


# ── Breach check (k-anonymity) ────────────────────────────────────────────────


def _range_response(password: str, count: int) -> tuple[str, str]:
    digest = hashlib.sha1(password.encode(), usedforsecurity=False).hexdigest().upper()
    body = f"0000000000000000000000000000000000A:0\r\n{digest[5:]}:{count}\r\n"
    return digest[:5], body


async def _check(password: str, count: int) -> tuple[bool, list[str]]:
    _, body = _range_response(password, count)
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        return httpx.Response(200, text=body)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await PwnedPasswordsChecker(client).is_breached(password)
    return result, requested


async def test_only_a_five_character_prefix_leaves_the_server() -> None:
    _, requested = await _check("hunter2-hunter2", 3)

    assert len(requested) == 1
    assert requested[0].rsplit("/", 1)[-1] == _range_response("hunter2-hunter2", 3)[0]


async def test_a_listed_suffix_is_breached_and_padding_is_not() -> None:
    assert (await _check("hunter2-hunter2", 3))[0] is True
    assert (await _check("hunter2-hunter2", 0))[0] is False  # count 0 = padding entry


async def test_the_check_fails_open_when_the_service_is_down() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        assert await PwnedPasswordsChecker(client).is_breached("anything-at-all") is False


# ── RBAC ──────────────────────────────────────────────────────────────────────


def test_roles_nest() -> None:
    order = [Role.CUSTOMER, Role.FULFILMENT, Role.STAFF, Role.ADMIN, Role.OWNER]
    for lower, higher in itertools.pairwise(order):
        assert ROLE_PERMISSIONS[lower] < ROLE_PERMISSIONS[higher], (lower, higher)


def test_customers_have_no_admin_permissions() -> None:
    assert permissions_for("customer") == frozenset()
    assert not is_staff("customer")


def test_refunds_are_admin_and_staff_management_is_owner_only() -> None:
    assert not has_permission("staff", Permission.ORDERS_REFUND)
    assert has_permission("admin", Permission.ORDERS_REFUND)
    assert not has_permission("admin", Permission.STAFF_MANAGE)
    assert has_permission("owner", Permission.STAFF_MANAGE)


def test_an_unknown_role_gets_nothing() -> None:
    assert permissions_for("superuser") == frozenset()
    assert not is_staff("superuser")


@pytest.mark.parametrize(("role", "expected"), [("customer", 403), ("admin", 200)])
async def test_require_permission_guards_a_route(role: str, expected: int) -> None:
    app = FastAPI()
    register_exception_handlers(app)
    app.dependency_overrides[get_current_principal] = lambda: Principal(
        user_id=uuid.uuid4(), role=role, session_id=uuid.uuid4()
    )

    @app.get("/refunds", dependencies=[Depends(require_permission(Permission.ORDERS_REFUND))])
    async def refunds() -> dict[str, bool]:
        return {"ok": True}

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as client:
        response = await client.get("/refunds")

    assert response.status_code == expected
