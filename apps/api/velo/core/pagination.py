"""Cursor pagination (API-SPEC.md §1, "Pagination") and the shared list envelope.

A cursor is opaque to clients: base64url JSON holding the last row's sort value
and id, typed so the value compares correctly in SQL, and tagged with the sort
it belongs to. A cursor from another sort, or a mangled one, is a 400 — never a
silently wrong page.
"""

from __future__ import annotations

import base64
import binascii
import json
import uuid
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from pydantic import BaseModel, Field

from velo.core.errors import DomainError

DEFAULT_LIMIT = 24
MAX_LIMIT = 100


class InvalidCursorError(DomainError):
    slug = "invalid-cursor"
    title = "Invalid cursor"


def encode_cursor(sort: str, key: Any, row_id: uuid.UUID) -> str:
    typed: dict[str, Any]
    if isinstance(key, datetime):
        typed = {"t": "dt", "v": key.isoformat()}
    elif isinstance(key, Decimal):
        typed = {"t": "dec", "v": str(key)}
    elif isinstance(key, bool) or key is None:
        raise ValueError("cursor keys must be a datetime, Decimal, int, or str")
    elif isinstance(key, int):
        typed = {"t": "int", "v": key}
    else:
        typed = {"t": "str", "v": str(key)}
    raw = json.dumps({"s": sort, "k": typed, "id": str(row_id)}, separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def decode_cursor(cursor: str, sort: str) -> tuple[Any, uuid.UUID]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded.encode()))
        if data["s"] != sort:
            raise InvalidCursorError("This cursor belongs to a different sort order.")
        kind, value = data["k"]["t"], data["k"]["v"]
        key: Any
        if kind == "dt":
            key = datetime.fromisoformat(value)
        elif kind == "dec":
            key = Decimal(value)
        elif kind == "int":
            key = int(value)
        elif kind == "str":
            key = str(value)
        else:
            raise InvalidCursorError("Unrecognised cursor.")
        return key, uuid.UUID(data["id"])
    except InvalidCursorError:
        raise
    except (ValueError, KeyError, TypeError, binascii.Error, InvalidOperation) as exc:
        raise InvalidCursorError("Unrecognised cursor.") from exc


class PaginationInfo(BaseModel):
    next_cursor: str | None
    has_more: bool
    limit: int
    total_count: int | None = Field(default=None, description="Admin lists only.")


class CursorPage[T](BaseModel):
    data: list[T]
    pagination: PaginationInfo


class MoneyJson(BaseModel):
    """``{"amount": 2999, "currency": "USD"}`` — minor units, never a float (ADR-005)."""

    amount: int
    currency: str
