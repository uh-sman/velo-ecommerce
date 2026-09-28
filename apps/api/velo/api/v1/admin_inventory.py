"""/admin/inventory — stock levels, adjustments with a reason, the movement ledger."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StringConstraints

from velo.api.deps import CatalogReaderDep, InventoryServiceDep, InventoryWriterDep
from velo.core.pagination import CursorPage, PaginationInfo, decode_cursor, encode_cursor
from velo.domains.catalog.schemas import StockView
from velo.domains.inventory.repository import MovementRecord, StockRecord

router = APIRouter(prefix="/admin/inventory", tags=["admin: inventory"])


class StockRowView(BaseModel):
    variant_id: uuid.UUID
    sku: str
    variant_title: str
    product_id: uuid.UUID
    product_title: str
    stock: StockView
    low_stock: bool


class MovementView(BaseModel):
    id: uuid.UUID
    quantity_delta: int
    reason: str
    reference_type: str | None
    reference_id: uuid.UUID | None
    actor_id: uuid.UUID | None
    note: str | None
    created_at: datetime

    @classmethod
    def of(cls, movement: MovementRecord) -> MovementView:
        return cls(
            id=movement.id,
            quantity_delta=movement.quantity_delta,
            reason=movement.reason,
            reference_type=movement.reference_type,
            reference_id=movement.reference_id,
            actor_id=movement.actor_id,
            note=movement.note,
            created_at=movement.created_at,
        )


class AdjustRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    delta: StrictInt = Field(description="Signed: +50 received, -2 damaged.")
    # Required: untraceable adjustments are how ledgers stop reconciling (API-SPEC.md §2).
    reason: Literal["restock", "return", "damage", "theft", "adjustment"]
    note: Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)] | None = None


class SettingsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reorder_point: Annotated[StrictInt, Field(ge=0)] | None = None
    track_inventory: bool | None = None
    allow_backorder: bool | None = None


class AdjustmentView(BaseModel):
    stock: StockView
    movement: MovementView


def _stock(record: StockRecord) -> StockView:
    return StockView(
        quantity_on_hand=record.quantity_on_hand,
        quantity_reserved=record.quantity_reserved,
        available=record.available,
        reorder_point=record.reorder_point,
        track_inventory=record.track_inventory,
        allow_backorder=record.allow_backorder,
    )


@router.get("", response_model=CursorPage[StockRowView], summary="Stock levels")
async def list_stock(
    _: CatalogReaderDep,
    service: InventoryServiceDep,
    low_stock: bool = False,
    q: Annotated[str | None, Query(max_length=100, description="SKU or product title.")] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    cursor: str | None = None,
) -> CursorPage[StockRowView]:
    after = decode_cursor(cursor, "inventory") if cursor else None
    rows, has_more, total = await service.list_stock(
        low_stock_only=low_stock, query_text=q, limit=limit, after=after
    )
    last = rows[-1] if rows else None
    return CursorPage[StockRowView](
        data=[
            StockRowView(
                variant_id=row.stock.variant_id,
                sku=row.sku,
                variant_title=row.variant_title,
                product_id=row.product_id,
                product_title=row.product_title,
                stock=_stock(row.stock),
                low_stock=row.stock.track_inventory
                and row.stock.available <= row.stock.reorder_point,
            )
            for row in rows
        ],
        pagination=PaginationInfo(
            next_cursor=encode_cursor("inventory", last.sku, last.stock.variant_id)
            if has_more and last
            else None,
            has_more=has_more,
            limit=limit,
            total_count=total,
        ),
    )


@router.post(
    "/{variant_id}/adjust", response_model=AdjustmentView, summary="Adjust stock, with a reason"
)
async def adjust_stock(
    variant_id: uuid.UUID,
    body: AdjustRequest,
    actor: InventoryWriterDep,
    service: InventoryServiceDep,
) -> AdjustmentView:
    result = await service.adjust(
        variant_id, delta=body.delta, reason=body.reason, note=body.note, actor=actor
    )
    return AdjustmentView(stock=_stock(result.stock), movement=MovementView.of(result.movement))


@router.patch("/{variant_id}", response_model=StockView, summary="Reorder point and tracking")
async def update_stock_settings(
    variant_id: uuid.UUID,
    body: SettingsRequest,
    actor: InventoryWriterDep,
    service: InventoryServiceDep,
) -> StockView:
    return _stock(
        await service.update_settings(
            variant_id,
            reorder_point=body.reorder_point,
            track_inventory=body.track_inventory,
            allow_backorder=body.allow_backorder,
            actor=actor,
        )
    )


@router.get(
    "/{variant_id}/movements", response_model=CursorPage[MovementView], summary="The stock ledger"
)
async def list_movements(
    variant_id: uuid.UUID,
    _: CatalogReaderDep,
    service: InventoryServiceDep,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    cursor: str | None = None,
) -> CursorPage[MovementView]:
    after = decode_cursor(cursor, "movements") if cursor else None
    movements, has_more = await service.movements(variant_id, limit=limit, after=after)
    last = movements[-1] if movements else None
    return CursorPage[MovementView](
        data=[MovementView.of(item) for item in movements],
        pagination=PaginationInfo(
            next_cursor=encode_cursor("movements", last.created_at, last.id)
            if has_more and last
            else None,
            has_more=has_more,
            limit=limit,
        ),
    )
