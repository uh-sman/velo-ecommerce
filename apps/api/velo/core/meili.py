"""A thin Meilisearch HTTP client (ADR-007).

About ten endpoints are used, so this is ``httpx`` with the timeouts under our
control rather than an SDK: a search engine that stops answering must cost a
shopper at most ``meilisearch_timeout_seconds`` before the Postgres fallback
takes over.

Every failure — refused connection, timeout, 5xx — surfaces as
:class:`SearchUnavailableError`, the one exception callers handle.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx

from velo.core.config import Settings


class SearchUnavailableError(Exception):
    """Meilisearch could not answer. Callers degrade; they do not fail."""


class MeiliClient:
    def __init__(self, settings: Settings, *, timeout: float | None = None) -> None:
        key = settings.meilisearch_master_key.get_secret_value()
        options: dict[str, Any] = {
            "base_url": settings.meilisearch_url.rstrip("/"),
            "headers": {"Authorization": f"Bearer {key}"} if key else {},
            "timeout": httpx.Timeout(timeout or settings.meilisearch_timeout_seconds, connect=1.0),
        }
        self._client = httpx.AsyncClient(**options)
        # Searches get their own client. Meilisearch writes a small response's
        # headers and body as separate segments; on a reused connection the body
        # then waits for the client's delayed ACK — ~40 ms on ~7% of searches,
        # measured on Linux. A fresh connection starts in quick-ACK mode, so it
        # never stalls; on a local network the handshake costs ~1.5 ms.
        # Across a WAN with TLS the handshake costs more than the stall saves:
        # set VELO_MEILISEARCH_SEARCH_KEEPALIVE=true there.
        self._search = (
            self._client
            if settings.meilisearch_search_keepalive
            else httpx.AsyncClient(**options, limits=httpx.Limits(max_keepalive_connections=0))
        )

    async def aclose(self) -> None:
        await self._client.aclose()
        if self._search is not self._client:
            await self._search.aclose()

    async def _request(
        self, method: str, path: str, *, client: httpx.AsyncClient | None = None, **kwargs: Any
    ) -> Any:
        try:
            response = await (client or self._client).request(method, path, **kwargs)
        except httpx.HTTPError as exc:
            raise SearchUnavailableError(f"{method} {path}: {exc!r}") from exc
        if response.status_code == 404:
            return None
        if response.status_code >= 400:
            raise SearchUnavailableError(
                f"{method} {path}: {response.status_code} {response.text[:300]}"
            )
        return response.json() if response.content else None

    # ── Health and indexes ───────────────────────────────────────────────

    async def healthy(self) -> bool:
        try:
            data = await self._request("GET", "/health")
        except SearchUnavailableError:
            return False
        return bool(data and data.get("status") == "available")

    async def index_exists(self, uid: str) -> bool:
        return await self._request("GET", f"/indexes/{uid}") is not None

    async def create_index(self, uid: str, primary_key: str = "id") -> int:
        task = await self._request("POST", "/indexes", json={"uid": uid, "primaryKey": primary_key})
        return int(task["taskUid"])

    async def delete_index(self, uid: str) -> int | None:
        task = await self._request("DELETE", f"/indexes/{uid}")
        return int(task["taskUid"]) if task else None

    async def update_settings(self, uid: str, settings: dict[str, Any]) -> int:
        task = await self._request("PATCH", f"/indexes/{uid}/settings", json=settings)
        return int(task["taskUid"])

    async def swap_indexes(self, first: str, second: str) -> int:
        task = await self._request("POST", "/swap-indexes", json=[{"indexes": [first, second]}])
        return int(task["taskUid"])

    async def document_count(self, uid: str) -> int:
        stats = await self._request("GET", f"/indexes/{uid}/stats")
        return int(stats["numberOfDocuments"]) if stats else 0

    async def list_indexes(self) -> list[str]:
        data = await self._request("GET", "/indexes", params={"limit": 1000})
        return [item["uid"] for item in (data or {}).get("results", [])]

    # ── Documents ────────────────────────────────────────────────────────

    async def add_documents(self, uid: str, documents: list[dict[str, Any]]) -> int:
        task = await self._request(
            "POST", f"/indexes/{uid}/documents", params={"primaryKey": "id"}, json=documents
        )
        return int(task["taskUid"])

    async def delete_documents(self, uid: str, ids: list[str]) -> int:
        task = await self._request("POST", f"/indexes/{uid}/documents/delete-batch", json=ids)
        return int(task["taskUid"])

    async def document_ids(self, uid: str, batch: int = 1000) -> set[str]:
        ids: set[str] = set()
        offset = 0
        while True:
            data = await self._request(
                "GET",
                f"/indexes/{uid}/documents",
                params={"fields": "id", "limit": batch, "offset": offset},
            )
            results = (data or {}).get("results", [])
            ids.update(str(item["id"]) for item in results)
            if len(results) < batch:
                return ids
            offset += batch

    # ── Search ───────────────────────────────────────────────────────────

    async def search(self, uid: str, body: dict[str, Any]) -> dict[str, Any]:
        """Search via GET, not POST.

        A POST goes out as two TCP segments (headers, then body). Behind a
        proxy that honours Nagle — Docker Desktop's port relay, some load
        balancers — the body waits for the headers' delayed ACK on every reused
        connection: a flat ~40-50 ms per search. A GET has no body, so it is
        one segment, and keep-alive stays on (measured: POST 50 ms, GET 4 ms).
        """
        params: dict[str, Any] = {}
        for key, value in body.items():
            if key == "filter":
                if value:
                    params["filter"] = " AND ".join(f"({clause})" for clause in value)
            elif isinstance(value, list):
                if value:
                    params[key] = ",".join(value)
            elif value is not None:
                params[key] = value
        data = await self._request(
            "GET", f"/indexes/{uid}/search", client=self._search, params=params
        )
        if data is None:
            raise SearchUnavailableError(f"index {uid} does not exist")
        return dict(data)

    # ── Tasks ────────────────────────────────────────────────────────────

    async def wait_for_task(self, task_uid: int, *, max_seconds: float = 120.0) -> dict[str, Any]:
        """Poll until the task finishes. A failed task raises."""
        deadline = asyncio.get_running_loop().time() + max_seconds
        delay = 0.05
        while True:
            task = await self._request("GET", f"/tasks/{task_uid}")
            status = task["status"]
            if status == "succeeded":
                return dict(task)
            if status in ("failed", "canceled"):
                raise SearchUnavailableError(f"task {task_uid} {status}: {task.get('error')}")
            if asyncio.get_running_loop().time() > deadline:
                raise SearchUnavailableError(f"task {task_uid} still {status} after {max_seconds}s")
            await asyncio.sleep(delay)
            delay = min(delay * 2, 1.0)
