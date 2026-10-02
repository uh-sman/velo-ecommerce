"""/admin/customers — who buys, how much, and what support knows (PLANNING.md Phase 11)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Query
from pydantic import BaseModel, ConfigDict, StringConstraints

from velo.api.deps import CustomerAdminDep, CustomersReaderDep, CustomersWriterDep
from velo.core.pagination import CursorPage, MoneyJson, PaginationInfo, decode_cursor, encode_cursor
from velo.domains.identity.customers import CustomerRow, NoteRecord

router = APIRouter(prefix="/admin/customers", tags=["admin: customers"])


class CustomerView(BaseModel):
    id: uuid.UUID
    email: str
    first_name: str | None
    last_name: str | None
    role: str
    status: str
    marketing_opt_in: bool
    created_at: datetime
    order_count: int
    lifetime_value: MoneyJson | None
    first_order_at: datetime | None
    last_order_at: datetime | None

    @classmethod
    def of(cls, row: CustomerRow) -> CustomerView:
        stats = row.stats
        return cls(
            id=row.id,
            email=row.email,
            first_name=row.first_name,
            last_name=row.last_name,
            role=row.role,
            status=row.status,
            marketing_opt_in=row.marketing_opt_in,
            created_at=row.created_at,
            order_count=stats.order_count,
            lifetime_value=MoneyJson(amount=stats.lifetime_value, currency=stats.currency)
            if stats.currency
            else None,
            first_order_at=stats.first_order_at,
            last_order_at=stats.last_order_at,
        )


class NoteView(BaseModel):
    id: uuid.UUID
    body: str
    author_email: str | None
    created_at: datetime

    @classmethod
    def of(cls, note: NoteRecord) -> NoteView:
        return cls(
            id=note.id, body=note.body, author_email=note.author_email, created_at=note.created_at
        )


class CustomerDetailView(CustomerView):
    phone: str | None
    email_verified: bool
    addresses: list[dict[str, Any]]
    recent_orders: list[dict[str, Any]]
    notes: list[NoteView]


class AddNote(BaseModel):
    model_config = ConfigDict(extra="forbid")

    body: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4000)]


@router.get("", response_model=CursorPage[CustomerView], summary="Customers, newest first")
async def list_customers(
    _: CustomersReaderDep,
    service: CustomerAdminDep,
    q: Annotated[str | None, Query(max_length=200, description="Email or name.")] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    cursor: str | None = None,
) -> CursorPage[CustomerView]:
    after = decode_cursor(cursor, "customers") if cursor else None
    rows, has_more, total = await service.search(query=q, limit=limit, after=after)
    last = rows[-1] if rows else None
    return CursorPage[CustomerView](
        data=[CustomerView.of(row) for row in rows],
        pagination=PaginationInfo(
            next_cursor=encode_cursor("customers", last.created_at, last.id)
            if has_more and last
            else None,
            has_more=has_more,
            limit=limit,
            total_count=total,
        ),
    )


@router.get("/{customer_id}", response_model=CustomerDetailView, summary="A customer's profile")
async def get_customer(
    customer_id: uuid.UUID, _: CustomersReaderDep, service: CustomerAdminDep
) -> CustomerDetailView:
    detail = await service.detail(customer_id)
    return CustomerDetailView(
        **CustomerView.of(detail.customer).model_dump(),
        phone=detail.phone,
        email_verified=detail.email_verified,
        addresses=detail.addresses,
        recent_orders=detail.recent_orders,
        notes=[NoteView.of(note) for note in detail.notes],
    )


@router.post("/{customer_id}/notes", response_model=NoteView, status_code=201, summary="Add a note")
async def add_note(
    customer_id: uuid.UUID, body: AddNote, actor: CustomersWriterDep, service: CustomerAdminDep
) -> NoteView:
    return NoteView.of(await service.add_note(customer_id, body.body, actor))
