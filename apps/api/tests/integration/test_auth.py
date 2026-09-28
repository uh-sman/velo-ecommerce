"""The auth flow end to end, against real Postgres and Redis (PLANNING.md Phase 5).

Definition of Done: signup → verify → login → refresh → logout → reset works;
refresh-token reuse kills the family; auth endpoints are rate limited; every
branch has a test, failure branches included.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from datetime import timedelta
from typing import Any

import pytest
from sqlalchemy import NullPool, text
from sqlalchemy.ext.asyncio import create_async_engine

from tests.conftest import TEST_ENV
from tests.integration.conftest import Browser
from velo.core.email import InMemoryMailer
from velo.domains.identity import service as identity_service

pytestmark = pytest.mark.integration

NewBrowser = Callable[[], AbstractAsyncContextManager[Browser]]

EMAIL = "casey@example.com"
PASSWORD = "tangerine-ocelot-harbour"
NEW_PASSWORD = "lantern-quartz-meadow"


async def register(browser: Browser, email: str = EMAIL, **extra: Any) -> Any:
    return await browser.post(
        "/api/v1/auth/register", json={"email": email, "password": PASSWORD, **extra}
    )


async def login(browser: Browser, email: str = EMAIL, password: str = PASSWORD) -> Any:
    return await browser.post("/api/v1/auth/login", json={"email": email, "password": password})


def link_token(mailer: InMemoryMailer, path: str) -> str:
    """The token from the most recent email linking to ``path``."""
    for message in reversed(mailer.outbox):
        match = re.search(rf"{path}\?token=(\S+)", message.text)
        if match:
            return match.group(1)
    raise AssertionError(f"no email links to {path}")


def slug(response: Any) -> str:
    return str(response.json()["type"]).rsplit("/", 1)[-1]


async def sql(statement: str, **params: Any) -> Any:
    engine = create_async_engine(TEST_ENV["VELO_DATABASE_URL"], poolclass=NullPool)
    async with engine.begin() as connection:
        result = await connection.execute(text(statement), params)
        value = result.scalar() if result.returns_rows else None
    await engine.dispose()
    return value


# ── CSRF ──────────────────────────────────────────────────────────────────────


async def test_first_contact_issues_a_csrf_cookie(browser: Browser) -> None:
    response = await browser.get("/api/v1/auth/csrf")

    assert response.status_code == 200
    assert response.json()["csrf_token"] == browser.csrf != ""
    set_cookie = response.headers["set-cookie"]
    assert "HttpOnly" not in set_cookie  # the frontend must be able to read it


async def test_mutations_without_a_matching_csrf_header_are_refused(browser: Browser) -> None:
    await browser.ensure_csrf()
    body = {"email": EMAIL, "password": PASSWORD}

    missing = await browser.client.post("/api/v1/auth/login", json=body)
    wrong = await browser.client.post(
        "/api/v1/auth/login", json=body, headers={"X-CSRF-Token": "forged"}
    )

    for response in (missing, wrong):
        assert response.status_code == 403
        assert slug(response) == "csrf-failed"


async def test_bearer_authenticated_requests_are_exempt_from_csrf(
    browser: Browser, new_browser: NewBrowser
) -> None:
    await register(browser)
    token = browser.client.cookies["velo_access"]

    async with new_browser() as mobile:  # no cookies at all, like an app
        response = await mobile.client.patch(
            "/api/v1/auth/me",
            json={"first_name": "Mobile"},
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code == 200
    assert response.json()["first_name"] == "Mobile"


# ── Registration ──────────────────────────────────────────────────────────────


async def test_register_signs_in_and_sends_a_verification_email(
    browser: Browser, mailer: InMemoryMailer
) -> None:
    response = await register(browser, first_name="Casey", marketing_opt_in=True)

    assert response.status_code == 201
    user = response.json()["user"]
    assert user["email"] == EMAIL
    assert user["role"] == "customer"
    assert user["email_verified"] is False
    assert user["marketing_opt_in"] is True

    cookies = response.headers.get_list("set-cookie")
    access = next(c for c in cookies if c.startswith("velo_access="))
    refresh = next(c for c in cookies if c.startswith("velo_refresh="))
    assert "HttpOnly" in access and "SameSite=lax" in access
    assert "HttpOnly" in refresh and "Path=/api/v1/auth/refresh" in refresh

    assert (await browser.get("/api/v1/auth/me")).json()["email"] == EMAIL
    assert mailer.outbox[-1].to == EMAIL
    assert "/verify-email?token=" in mailer.outbox[-1].text


async def test_register_refuses_a_taken_email_regardless_of_case(
    browser: Browser, new_browser: NewBrowser
) -> None:
    await register(browser)
    async with new_browser() as other:
        response = await register(other, email=EMAIL.upper())

    assert response.status_code == 409
    assert slug(response) == "email-taken"


@pytest.mark.parametrize(
    ("password", "code"),
    [("short", "too_short"), ("x" * 129, "too_long"), (EMAIL, "matches_email")],
)
async def test_register_enforces_the_password_policy(
    browser: Browser, password: str, code: str
) -> None:
    response = await browser.post(
        "/api/v1/auth/register", json={"email": EMAIL, "password": password}
    )

    assert response.status_code == 422
    assert response.json()["errors"][0]["code"] == code


async def test_register_refuses_a_breached_password(
    browser: Browser, breached_passwords: set[str]
) -> None:
    breached_passwords.add(PASSWORD)

    response = await register(browser)

    assert response.status_code == 422
    assert response.json()["errors"][0]["code"] == "breached"


async def test_register_rejects_unknown_fields(browser: Browser) -> None:
    response = await register(browser, role="owner")  # privilege escalation attempt

    assert response.status_code == 422


async def test_register_is_rate_limited_per_ip(browser: Browser) -> None:
    for number in range(3):
        assert (await register(browser, email=f"user{number}@example.com")).status_code == 201

    response = await register(browser, email="user3@example.com")

    assert response.status_code == 429
    assert int(response.headers["Retry-After"]) > 0


# ── Sign-in, lockout, and rate limits ─────────────────────────────────────────


async def test_login_succeeds_and_resets_the_failure_count(
    browser: Browser, new_browser: NewBrowser
) -> None:
    await register(browser)
    async with new_browser() as other:
        assert (await login(other, password="wrong-password-1")).status_code == 401
        response = await login(other)

    assert response.status_code == 200
    assert response.json()["user"]["email"] == EMAIL
    assert await sql("SELECT failed_login_count FROM users") == 0


async def test_wrong_password_and_unknown_email_are_indistinguishable(browser: Browser) -> None:
    await register(browser)

    wrong_password = await login(browser, password="not-the-password")
    unknown_email = await login(browser, email="nobody@example.com")

    for response in (wrong_password, unknown_email):
        assert response.status_code == 401
        assert slug(response) == "invalid-credentials"
    assert wrong_password.json()["title"] == unknown_email.json()["title"]


async def test_repeated_failures_lock_the_account_and_email_the_owner(
    browser: Browser, mailer: InMemoryMailer
) -> None:
    await register(browser)
    for _ in range(identity_service.LOCKOUT_THRESHOLD):
        assert (await login(browser, password="guess")).status_code == 401

    # Clear the Redis limiter: the lock itself lives in Postgres and must hold alone.
    redis_url = TEST_ENV["VELO_REDIS_URL"]
    from redis.asyncio import Redis

    redis = Redis.from_url(redis_url)
    await redis.flushdb()
    await redis.aclose()

    response = await login(browser)  # the right password, too late

    assert response.status_code == 429
    assert slug(response) == "too-many-attempts"
    assert int(response.headers["Retry-After"]) > 14 * 60
    assert mailer.outbox[-1].subject == "Your Velo account was temporarily locked"


async def test_lockout_backs_off_exponentially(browser: Browser) -> None:
    await register(browser)
    await sql("UPDATE users SET failed_login_count = 9")  # one short of the second strike

    await login(browser, password="guess")
    locked_for = await sql("SELECT locked_until - now() FROM users")

    assert timedelta(minutes=29) < locked_for <= timedelta(minutes=30)


async def test_login_is_rate_limited_per_ip_across_accounts(browser: Browser) -> None:
    for number in range(5):
        await login(browser, email=f"victim{number}@example.com", password="spray")

    response = await login(browser, email="victim5@example.com", password="spray")

    assert response.status_code == 429
    assert slug(response) == "too-many-attempts"


async def test_a_suspended_account_cannot_sign_in(browser: Browser) -> None:
    await register(browser)
    await sql("UPDATE users SET status = 'suspended'")

    response = await login(browser)

    assert response.status_code == 403
    assert slug(response) == "account-suspended"


# ── Refresh rotation and reuse detection ──────────────────────────────────────


async def test_refresh_rotates_the_token(browser: Browser) -> None:
    await register(browser)
    before = browser.client.cookies["velo_refresh"]

    response = await browser.post("/api/v1/auth/refresh")

    assert response.status_code == 200
    assert browser.client.cookies["velo_refresh"] != before


async def test_reusing_a_spent_refresh_token_revokes_the_whole_family(
    browser: Browser, new_browser: NewBrowser, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(identity_service, "REFRESH_REUSE_GRACE", timedelta(0))
    await register(browser)
    stolen = browser.client.cookies["velo_refresh"]
    assert (await browser.post("/api/v1/auth/refresh")).status_code == 200  # owner rotates

    async with new_browser() as thief:
        thief.client.cookies.set("velo_refresh", stolen, path="/api/v1/auth/refresh")
        replay = await thief.post("/api/v1/auth/refresh")

    assert replay.status_code == 401
    assert slug(replay) == "session-expired"
    # The owner's current token died with the family: whoever holds it must sign in again.
    owner = await browser.post("/api/v1/auth/refresh")
    assert owner.status_code == 401


async def test_concurrent_refresh_inside_the_grace_window_is_not_treated_as_theft(
    browser: Browser, new_browser: NewBrowser
) -> None:
    await register(browser)
    shared = browser.client.cookies["velo_refresh"]
    assert (await browser.post("/api/v1/auth/refresh")).status_code == 200

    async with new_browser() as second_tab:
        second_tab.client.cookies.set("velo_refresh", shared, path="/api/v1/auth/refresh")
        raced = await second_tab.post("/api/v1/auth/refresh")

    assert raced.status_code == 409
    assert slug(raced) == "refresh-superseded"
    assert (await browser.post("/api/v1/auth/refresh")).status_code == 200  # family intact


async def test_refresh_without_a_cookie_is_unauthenticated(browser: Browser) -> None:
    response = await browser.post("/api/v1/auth/refresh")

    assert response.status_code == 401
    assert slug(response) == "session-expired"


async def test_refresh_fails_once_the_account_is_suspended(browser: Browser) -> None:
    await register(browser)
    await sql("UPDATE users SET status = 'suspended'")

    assert (await browser.post("/api/v1/auth/refresh")).status_code == 401


async def test_staff_sessions_get_a_seven_day_refresh_window(browser: Browser) -> None:
    await register(browser)
    await sql("UPDATE users SET role = 'admin'")

    response = await login(browser)

    refresh = next(
        c for c in response.headers.get_list("set-cookie") if c.startswith("velo_refresh=")
    )
    assert f"Max-Age={7 * 24 * 3600}" in refresh


# ── Sign-out and sessions ─────────────────────────────────────────────────────


async def test_logout_revokes_the_session_server_side(browser: Browser) -> None:
    await register(browser)
    refresh_token = browser.client.cookies["velo_refresh"]

    response = await browser.post("/api/v1/auth/logout")

    assert response.status_code == 204
    assert "velo_access" not in browser.client.cookies
    # Even a copy of the refresh token taken before logout is now worthless.
    browser.client.cookies.set("velo_refresh", refresh_token, path="/api/v1/auth/refresh")
    assert (await browser.post("/api/v1/auth/refresh")).status_code == 401


async def test_sessions_are_listed_and_individually_revocable(
    browser: Browser, new_browser: NewBrowser
) -> None:
    await register(browser)
    async with new_browser() as laptop:
        await login(laptop)

        sessions = (await browser.get("/api/v1/auth/sessions")).json()
        assert len(sessions) == 2
        other = next(session for session in sessions if not session["is_current"])

        revoked = await browser.delete(f"/api/v1/auth/sessions/{other['id']}")
        assert revoked.status_code == 204
        assert (await laptop.post("/api/v1/auth/refresh")).status_code == 401

    assert len((await browser.get("/api/v1/auth/sessions")).json()) == 1


async def test_another_users_session_is_not_found(
    browser: Browser, new_browser: NewBrowser
) -> None:
    await register(browser)
    async with new_browser() as other:
        await register(other, email="other@example.com")
        their_session = (await other.get("/api/v1/auth/sessions")).json()[0]["id"]

    response = await browser.delete(f"/api/v1/auth/sessions/{their_session}")

    assert response.status_code == 404


# ── Profile and password change ───────────────────────────────────────────────


async def test_me_requires_authentication(browser: Browser) -> None:
    response = await browser.get("/api/v1/auth/me")

    assert response.status_code == 401
    assert slug(response) == "unauthenticated"


async def test_a_forged_access_token_is_rejected(browser: Browser) -> None:
    browser.client.cookies.set("velo_access", "eyJhbGciOiJub25lIn0.e30.")

    assert (await browser.get("/api/v1/auth/me")).status_code == 401


async def test_profile_update_changes_only_what_is_sent(browser: Browser) -> None:
    await register(browser, first_name="Casey", marketing_opt_in=True)

    response = await browser.patch("/api/v1/auth/me", json={"last_name": "Jones"})

    assert response.status_code == 200
    assert response.json()["first_name"] == "Casey"
    assert response.json()["last_name"] == "Jones"
    assert response.json()["marketing_opt_in"] is True


async def test_change_password_needs_the_current_one_and_signs_out_other_devices(
    browser: Browser, new_browser: NewBrowser, mailer: InMemoryMailer
) -> None:
    await register(browser)
    async with new_browser() as laptop:
        await login(laptop)

        wrong = await browser.post(
            "/api/v1/auth/change-password",
            json={"current_password": "not-it-at-all", "new_password": NEW_PASSWORD},
        )
        assert wrong.status_code == 422
        assert slug(wrong) == "wrong-password"

        changed = await browser.post(
            "/api/v1/auth/change-password",
            json={"current_password": PASSWORD, "new_password": NEW_PASSWORD},
        )
        assert changed.status_code == 204
        assert (await laptop.post("/api/v1/auth/refresh")).status_code == 401

    assert (await browser.post("/api/v1/auth/refresh")).status_code == 200  # this device stays
    assert (await login(browser, password=NEW_PASSWORD)).status_code == 200
    assert mailer.outbox[-1].subject == "Your Velo password was changed"


# ── Email verification ────────────────────────────────────────────────────────


async def test_email_verification_link_verifies_once_and_harmlessly_twice(
    browser: Browser, mailer: InMemoryMailer
) -> None:
    await register(browser)
    token = link_token(mailer, "/verify-email")

    first = await browser.post("/api/v1/auth/verify-email", json={"token": token})
    second = await browser.post("/api/v1/auth/verify-email", json={"token": token})

    assert first.status_code == second.status_code == 204
    assert (await browser.get("/api/v1/auth/me")).json()["email_verified"] is True


@pytest.mark.parametrize("tamper", ["truncate", "wrong-type"])
async def test_an_invalid_verification_link_is_refused(
    browser: Browser, mailer: InMemoryMailer, tamper: str
) -> None:
    await register(browser)
    if tamper == "truncate":
        token = link_token(mailer, "/verify-email")[:-4]
    else:  # a password-reset token presented as a verification token
        await browser.post("/api/v1/auth/forgot-password", json={"email": EMAIL})
        token = link_token(mailer, "/reset-password")

    response = await browser.post("/api/v1/auth/verify-email", json={"token": token})

    assert response.status_code == 400
    assert slug(response) == "invalid-or-expired-link"


async def test_resend_verification_never_reveals_whether_an_account_exists(
    browser: Browser, mailer: InMemoryMailer
) -> None:
    await register(browser)
    sent = len(mailer.outbox)

    unknown = await browser.post(
        "/api/v1/auth/resend-verification", json={"email": "nobody@example.com"}
    )
    known = await browser.post("/api/v1/auth/resend-verification", json={"email": EMAIL})

    assert unknown.status_code == known.status_code == 204
    assert len(mailer.outbox) == sent + 1


# ── Password reset ────────────────────────────────────────────────────────────


async def test_forgot_password_is_silent_about_unknown_emails(
    browser: Browser, mailer: InMemoryMailer
) -> None:
    response = await browser.post(
        "/api/v1/auth/forgot-password", json={"email": "nobody@example.com"}
    )

    assert response.status_code == 204
    assert mailer.outbox == []


async def test_password_reset_works_once_and_revokes_every_session(
    browser: Browser, new_browser: NewBrowser, mailer: InMemoryMailer
) -> None:
    await register(browser)
    async with new_browser() as anonymous:
        await anonymous.post("/api/v1/auth/forgot-password", json={"email": EMAIL})
        token = link_token(mailer, "/reset-password")

        reset = await anonymous.post(
            "/api/v1/auth/reset-password", json={"token": token, "password": NEW_PASSWORD}
        )
        assert reset.status_code == 204

        replay = await anonymous.post(
            "/api/v1/auth/reset-password", json={"token": token, "password": "another-one-entirely"}
        )
        assert replay.status_code == 400
        assert slug(replay) == "invalid-or-expired-link"

        assert (await login(anonymous, password=PASSWORD)).status_code == 401
        assert (await login(anonymous, password=NEW_PASSWORD)).status_code == 200

    assert (await browser.post("/api/v1/auth/refresh")).status_code == 401  # signed out


async def test_password_reset_lifts_a_lockout_and_verifies_the_email(
    browser: Browser, mailer: InMemoryMailer
) -> None:
    await register(browser)
    await sql("UPDATE users SET failed_login_count = 5, locked_until = now() + interval '1 hour'")
    await browser.post("/api/v1/auth/forgot-password", json={"email": EMAIL})

    await browser.post(
        "/api/v1/auth/reset-password",
        json={"token": link_token(mailer, "/reset-password"), "password": NEW_PASSWORD},
    )

    assert (await login(browser, password=NEW_PASSWORD)).status_code == 200
    assert (await browser.get("/api/v1/auth/me")).json()["email_verified"] is True


async def test_password_reset_still_enforces_the_policy(
    browser: Browser, mailer: InMemoryMailer
) -> None:
    await register(browser)
    await browser.post("/api/v1/auth/forgot-password", json={"email": EMAIL})

    response = await browser.post(
        "/api/v1/auth/reset-password",
        json={"token": link_token(mailer, "/reset-password"), "password": "short"},
    )

    assert response.status_code == 422


async def test_forgot_password_is_rate_limited_per_email(browser: Browser) -> None:
    await register(browser)
    for _ in range(3):
        assert (
            await browser.post("/api/v1/auth/forgot-password", json={"email": EMAIL})
        ).status_code == 204

    response = await browser.post("/api/v1/auth/forgot-password", json={"email": EMAIL})

    assert response.status_code == 429
    assert "X-RateLimit-Limit" in response.headers
