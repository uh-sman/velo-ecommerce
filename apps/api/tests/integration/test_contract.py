"""Contract tests: the running API against its own OpenAPI document (PLANNING.md Phase 13).

schemathesis generates requests for every operation, valid and not, from the
published schema and sends them to a real server on the test database. Every
answer must be no 5xx, a status and content type the document declares, and a
body that matches the declared schema — errors included, which are RFC 9457
problems (velo/api/openapi.py). Requests carry a staff owner's bearer token,
so the admin surface is exercised too; operations that would end that
session are left out.

    VELO_RUN_INTEGRATION=1 uv run pytest -m contract
    VELO_CONTRACT_PATHS='/admin/tax' VELO_CONTRACT_EXAMPLES=50 ...   # a few, harder
"""

from __future__ import annotations

import asyncio
import os
import socket
import subprocess
import sys
import time
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
import schemathesis
from hypothesis import HealthCheck, settings
from redis import Redis
from schemathesis.checks import not_a_server_error
from schemathesis.specs.openapi.checks import (
    content_type_conformance,
    response_schema_conformance,
    status_code_conformance,
)
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from tests.conftest import TEST_ENV

pytestmark = [pytest.mark.integration, pytest.mark.contract]

PASSWORD = "contract-ocelot-harbour"
EMAIL = "contract@example.com"
# Each of these ends the bearer's session, after which every request is a 401.
SESSION_ENDING = r"/auth/(logout|sessions)|/account/(sessions|password|delete)|/admin/staff"
CHECKS: list[Any] = [
    not_a_server_error,
    status_code_conformance,
    content_type_conformance,
    response_schema_conformance,
]


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


async def _sql(statement: str, **params: Any) -> None:
    engine = create_async_engine(TEST_ENV["VELO_DATABASE_URL"], poolclass=NullPool)
    async with engine.begin() as connection:
        await connection.execute(text(statement), params)
    await engine.dispose()


# Module-scoped, not session: the teardown truncates and flushes Redis as soon as
# this module is done. Session-scoped, the fuzzer's login attempts stayed in the
# rate limiter and the next module's first sign-in was refused with a 429.
@pytest.fixture(scope="module")
def contract_server(
    migrated_database: str, tmp_path_factory: pytest.TempPathFactory
) -> Iterator[dict[str, str]]:
    port = _free_port()
    base = f"http://127.0.0.1:{port}"
    env = {
        **os.environ,
        **TEST_ENV,
        "VELO_ACCESS_TOKEN_TTL_SECONDS": "7200",  # outlasts the run
        "VELO_BREACH_CHECK_ENABLED": "false",
        "PYTHONUNBUFFERED": "1",
        # Generated paths hold any character; a cp1252 console would crash the logger.
        "PYTHONIOENCODING": "utf-8",
    }
    # The server's own log, tracebacks included: where a 500 is explained.
    log_path = tmp_path_factory.mktemp("contract") / "server.log"
    log = log_path.open("w", encoding="utf-8")
    print(f"contract server log: {log_path}")  # noqa: T201 — where to look when a 500 fails
    server = subprocess.Popen(  # noqa: S603 — fixed arguments
        [
            sys.executable,
            "-m",
            "uvicorn",
            "velo.main:app",
            "--port",
            str(port),
            "--log-level",
            "warning",
        ],
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    try:
        deadline = time.monotonic() + 60
        while True:
            try:
                if httpx.get(f"{base}/health", timeout=2).status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            if time.monotonic() > deadline or server.poll() is not None:
                raise RuntimeError("the API did not start for the contract tests")
            time.sleep(0.5)

        with httpx.Client(base_url=base) as client:
            client.get("/api/v1/system/info")  # first contact hands out the CSRF cookie

            def csrf() -> dict[str, str]:  # signing up rotates it: read it fresh each time
                return {"X-CSRF-Token": client.cookies.get("velo_csrf") or ""}

            client.post(
                "/api/v1/auth/register", json={"email": EMAIL, "password": PASSWORD}, headers=csrf()
            )
            asyncio.run(
                _sql(
                    "UPDATE users SET role = 'owner', email_verified_at = now() WHERE email = :e",
                    e=EMAIL,
                )
            )
            login = client.post(
                "/api/v1/auth/login", json={"email": EMAIL, "password": PASSWORD}, headers=csrf()
            )
            assert login.status_code == 200, login.text
            token = login.cookies["velo_access"]

        yield {"base": base, "token": token}
    finally:
        server.terminate()
        server.wait(timeout=30)
        log.close()
        asyncio.run(
            _sql(
                "TRUNCATE users, categories, products, collections, outbox_events, audit_log, "
                "inventory_movements, carts, discounts, shipping_zones, tax_rates CASCADE"
            )
        )
        redis = Redis.from_url(TEST_ENV["VELO_REDIS_URL"])
        redis.flushdb()
        redis.close()


@pytest.fixture(scope="module")
def contract_schema(contract_server: dict[str, str]) -> Any:
    return schemathesis.openapi.from_url(f"{contract_server['base']}/openapi.json")


# Filters go on the lazy schema: ones applied inside the fixture are not carried through.
schema = schemathesis.pytest.from_fixture("contract_schema").exclude(path_regex=SESSION_ENDING)
if only := os.environ.get("VELO_CONTRACT_PATHS"):  # a regex, to rerun a few operations
    schema = schema.include(path_regex=only)


@schema.parametrize()
@settings(
    max_examples=int(os.environ.get("VELO_CONTRACT_EXAMPLES", "20")),
    deadline=None,
    suppress_health_check=list(HealthCheck),
)
def test_the_api_keeps_its_published_contract(
    case: schemathesis.Case[Any], contract_server: dict[str, str]
) -> None:
    case.call_and_validate(
        base_url=contract_server["base"],
        headers={"Authorization": f"Bearer {contract_server['token']}"},
        checks=CHECKS,
    )
