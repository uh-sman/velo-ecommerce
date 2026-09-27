"""Correlation IDs: minted when absent, propagated when present, always echoed."""

from __future__ import annotations

from httpx import AsyncClient

REQUEST_ID_HEADER = "X-Request-ID"


async def test_a_request_id_is_minted_when_the_caller_sends_none(client: AsyncClient) -> None:
    response = await client.get("/health")

    assert REQUEST_ID_HEADER in response.headers
    assert len(response.headers[REQUEST_ID_HEADER]) == 26  # ULID


async def test_an_inbound_request_id_is_propagated(client: AsyncClient) -> None:
    response = await client.get("/health", headers={REQUEST_ID_HEADER: "trace-from-the-edge"})

    assert response.headers[REQUEST_ID_HEADER] == "trace-from-the-edge"


async def test_an_oversized_inbound_request_id_is_truncated(client: AsyncClient) -> None:
    """A caller-supplied value is only ever used for correlation, so capping it
    is enough — but uncapped it would be an unbounded string in every log line."""
    response = await client.get("/health", headers={REQUEST_ID_HEADER: "x" * 500})

    assert len(response.headers[REQUEST_ID_HEADER]) == 64


async def test_two_requests_get_distinct_ids(client: AsyncClient) -> None:
    first = await client.get("/health")
    second = await client.get("/health")

    assert first.headers[REQUEST_ID_HEADER] != second.headers[REQUEST_ID_HEADER]


async def test_the_request_id_appears_in_the_error_envelope(client: AsyncClient) -> None:
    response = await client.get("/api/v1/does-not-exist")

    assert response.status_code == 404
    assert response.json()["request_id"] == response.headers[REQUEST_ID_HEADER]
