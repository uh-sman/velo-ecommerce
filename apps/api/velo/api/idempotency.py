"""``Idempotency-Key`` on money-moving POSTs (API-SPEC.md §1, PAYMENTS-AND-CHECKOUT.md §5).

The HTTP half of :class:`~velo.domains.payments.service.IdempotencyService`:
read the header, fingerprint the request, and turn the stored response back
into a response — with ``Idempotency-Replayed: true`` when it is a replay.

The frontend generates the key once per step (on landing on the payment step,
not per click), so every retry of the same intent carries the same key.
"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable

from fastapi import Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from velo.domains.payments.exceptions import IdempotencyKeyRequiredError
from velo.domains.payments.service import (
    IdempotencyService,
    StoredResponse,
    request_fingerprint,
)

IDEMPOTENCY_HEADER = "Idempotency-Key"
REPLAYED_HEADER = "Idempotency-Replayed"


def idempotency_key(request: Request) -> uuid.UUID:
    raw = request.headers.get(IDEMPOTENCY_HEADER, "").strip()
    if not raw:
        raise IdempotencyKeyRequiredError(
            f"Send an {IDEMPOTENCY_HEADER} header (a UUID) with this request."
        )
    try:
        return uuid.UUID(raw)
    except ValueError as exc:
        raise IdempotencyKeyRequiredError(f"{IDEMPOTENCY_HEADER} must be a UUID.") from exc


async def run_idempotent(
    request: Request,
    service: IdempotencyService,
    *,
    user_id: uuid.UUID | None,
    status_code: int,
    work: Callable[[], Awaitable[BaseModel]],
) -> StoredResponse:
    key = idempotency_key(request)
    endpoint = f"{request.method} {request.url.path}"

    async def execute() -> tuple[int, dict[str, object]]:
        return status_code, (await work()).model_dump(mode="json")

    return await service.run(
        key,
        user_id=user_id,
        endpoint=endpoint,
        request_hash=request_fingerprint(request.method, request.url.path, await request.body()),
        work=execute,
    )


def stored_response(stored: StoredResponse) -> JSONResponse:
    response = JSONResponse(stored.body, status_code=stored.status)
    response.headers["Cache-Control"] = "no-store"
    if stored.replayed:
        response.headers[REPLAYED_HEADER] = "true"
    return response
