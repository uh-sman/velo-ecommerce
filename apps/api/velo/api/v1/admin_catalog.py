"""/admin catalog — products, variants, media, categories, collections, reviews, CSV.

Reads need admin access; every write needs ``catalog:write`` and is recorded in
the audit log with the actor (API-SPEC.md §2, "Admin").
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Query, Request, status
from fastapi.responses import Response, StreamingResponse

from velo.api.deps import (
    CatalogAdminDep,
    CatalogReaderDep,
    CatalogWriterDep,
    CsvServiceDep,
    ReviewServiceDep,
)
from velo.api.openapi import CSV
from velo.core.errors import ValidationError
from velo.core.pagination import CursorPage
from velo.domains.catalog.csv_io import ImportRejectedError, ImportReport
from velo.domains.catalog.schemas import (
    AdminCategoryView,
    AdminCollectionView,
    AdminProductRow,
    AdminProductView,
    AdminReviewView,
    CategoryCreate,
    CategoryUpdate,
    CollectionCreate,
    CollectionUpdate,
    MediaAttach,
    MediaUpdate,
    PresignRequest,
    PresignResponse,
    ProductCreate,
    ProductUpdate,
    ReviewModeration,
    VariantInput,
    VariantUpdate,
)
from velo.domains.catalog.views import MediaView

router = APIRouter(prefix="/admin", tags=["admin: catalog"])

MAX_IMPORT_BYTES = 5 * 1024 * 1024
NO_CONTENT = status.HTTP_204_NO_CONTENT
CREATED = status.HTTP_201_CREATED


# ── Products ──────────────────────────────────────────────────────────────────


@router.get("/products", response_model=CursorPage[AdminProductRow], summary="List products")
async def list_products(
    _: CatalogReaderDep,
    service: CatalogAdminDep,
    status_filter: Annotated[
        Literal["draft", "active", "archived"] | None, Query(alias="status")
    ] = None,
    q: Annotated[str | None, Query(max_length=100, description="Title, slug or SKU.")] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    cursor: str | None = None,
) -> CursorPage[AdminProductRow]:
    return await service.list_products(
        status=status_filter, query_text=q, limit=limit, cursor=cursor
    )


@router.post(
    "/products", response_model=AdminProductView, status_code=CREATED, summary="Create a product"
)
async def create_product(
    body: ProductCreate, actor: CatalogWriterDep, service: CatalogAdminDep
) -> AdminProductView:
    return await service.create_product(body, actor)


# Declared before /products/{product_id} so "export" is not read as an id.
@router.get(
    "/products/export",
    summary="Export the catalog as CSV",
    response_class=Response,
    responses=CSV,
)
async def export_products(_: CatalogReaderDep, service: CsvServiceDep) -> StreamingResponse:
    filename = f"velo-catalog-{datetime.now(UTC):%Y%m%d-%H%M}.csv"
    return StreamingResponse(
        service.export_rows(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post(
    "/products/bulk-import",
    response_model=ImportReport,
    summary="Import products from CSV (all or nothing; dry_run to preview)",
    openapi_extra={
        "requestBody": {"content": {"text/csv": {"schema": {"type": "string", "format": "binary"}}}}
    },
)
async def bulk_import(
    request: Request,
    actor: CatalogWriterDep,
    service: CsvServiceDep,
    dry_run: bool = True,
) -> ImportReport:
    # The CSV is the raw body. Dry run is the default: applying is a deliberate choice.
    data = await request.body()
    if len(data) > MAX_IMPORT_BYTES:
        raise ValidationError(f"At most {MAX_IMPORT_BYTES // (1024 * 1024)} MB per import.")
    try:
        return await service.import_csv(data, dry_run=dry_run, actor=actor)
    except ImportRejectedError as exc:
        raise ValidationError(str(exc)) from exc


@router.get("/products/{product_id}", response_model=AdminProductView, summary="Get a product")
async def get_product(
    product_id: uuid.UUID, _: CatalogReaderDep, service: CatalogAdminDep
) -> AdminProductView:
    return await service.get_product(product_id)


@router.patch("/products/{product_id}", response_model=AdminProductView, summary="Update a product")
async def update_product(
    product_id: uuid.UUID, body: ProductUpdate, actor: CatalogWriterDep, service: CatalogAdminDep
) -> AdminProductView:
    return await service.update_product(product_id, body, actor)


@router.delete("/products/{product_id}", status_code=NO_CONTENT, summary="Delete (soft) a product")
async def delete_product(
    product_id: uuid.UUID, actor: CatalogWriterDep, service: CatalogAdminDep
) -> None:
    await service.delete_product(product_id, actor)


# ── Variants ──────────────────────────────────────────────────────────────────


@router.post(
    "/products/{product_id}/variants",
    response_model=AdminProductView,
    status_code=CREATED,
    summary="Add a variant",
)
async def add_variant(
    product_id: uuid.UUID, body: VariantInput, actor: CatalogWriterDep, service: CatalogAdminDep
) -> AdminProductView:
    return await service.add_variant(product_id, body, actor)


@router.patch("/variants/{variant_id}", response_model=AdminProductView, summary="Update a variant")
async def update_variant(
    variant_id: uuid.UUID, body: VariantUpdate, actor: CatalogWriterDep, service: CatalogAdminDep
) -> AdminProductView:
    return await service.update_variant(variant_id, body, actor)


@router.delete(
    "/variants/{variant_id}", response_model=AdminProductView, summary="Delete a variant"
)
async def delete_variant(
    variant_id: uuid.UUID, actor: CatalogWriterDep, service: CatalogAdminDep
) -> AdminProductView:
    return await service.delete_variant(variant_id, actor)


# ── Media ─────────────────────────────────────────────────────────────────────


@router.post(
    "/media/presign", response_model=PresignResponse, summary="Get a presigned upload for an image"
)
async def presign_media(
    body: PresignRequest, _: CatalogWriterDep, service: CatalogAdminDep
) -> PresignResponse:
    return await service.presign(body)


@router.post(
    "/products/{product_id}/media",
    response_model=MediaView,
    status_code=CREATED,
    summary="Attach an uploaded image",
)
async def attach_media(
    product_id: uuid.UUID, body: MediaAttach, actor: CatalogWriterDep, service: CatalogAdminDep
) -> MediaView:
    return await service.attach_media(product_id, body, actor)


@router.patch("/media/{media_id}", response_model=MediaView, summary="Update alt text or order")
async def update_media(
    media_id: uuid.UUID, body: MediaUpdate, actor: CatalogWriterDep, service: CatalogAdminDep
) -> MediaView:
    return await service.update_media(media_id, body, actor)


@router.delete("/media/{media_id}", status_code=NO_CONTENT, summary="Delete an image")
async def delete_media(
    media_id: uuid.UUID, actor: CatalogWriterDep, service: CatalogAdminDep
) -> None:
    await service.delete_media(media_id, actor)


# ── Categories ────────────────────────────────────────────────────────────────


@router.get("/categories", response_model=list[AdminCategoryView], summary="List categories")
async def list_categories(_: CatalogReaderDep, service: CatalogAdminDep) -> list[AdminCategoryView]:
    return await service.list_categories()


@router.post("/categories", response_model=AdminCategoryView, status_code=CREATED, summary="Create")
async def create_category(
    body: CategoryCreate, actor: CatalogWriterDep, service: CatalogAdminDep
) -> AdminCategoryView:
    return await service.create_category(body, actor)


@router.patch(
    "/categories/{category_id}", response_model=AdminCategoryView, summary="Rename or move"
)
async def update_category(
    category_id: uuid.UUID, body: CategoryUpdate, actor: CatalogWriterDep, service: CatalogAdminDep
) -> AdminCategoryView:
    return await service.update_category(category_id, body, actor)


@router.delete("/categories/{category_id}", status_code=NO_CONTENT, summary="Delete a category")
async def delete_category(
    category_id: uuid.UUID, actor: CatalogWriterDep, service: CatalogAdminDep
) -> None:
    await service.delete_category(category_id, actor)


# ── Collections ───────────────────────────────────────────────────────────────


@router.get("/collections", response_model=list[AdminCollectionView], summary="List collections")
async def list_collections(
    _: CatalogReaderDep, service: CatalogAdminDep
) -> list[AdminCollectionView]:
    return await service.list_collections()


@router.post(
    "/collections", response_model=AdminCollectionView, status_code=CREATED, summary="Create"
)
async def create_collection(
    body: CollectionCreate, actor: CatalogWriterDep, service: CatalogAdminDep
) -> AdminCollectionView:
    return await service.create_collection(body, actor)


@router.patch("/collections/{collection_id}", response_model=AdminCollectionView, summary="Update")
async def update_collection(
    collection_id: uuid.UUID,
    body: CollectionUpdate,
    actor: CatalogWriterDep,
    service: CatalogAdminDep,
) -> AdminCollectionView:
    return await service.update_collection(collection_id, body, actor)


@router.delete("/collections/{collection_id}", status_code=NO_CONTENT, summary="Delete")
async def delete_collection(
    collection_id: uuid.UUID, actor: CatalogWriterDep, service: CatalogAdminDep
) -> None:
    await service.delete_collection(collection_id, actor)


# ── Reviews ───────────────────────────────────────────────────────────────────


@router.get("/reviews", response_model=CursorPage[AdminReviewView], summary="Reviews to moderate")
async def list_reviews(
    _: CatalogReaderDep,
    service: ReviewServiceDep,
    status_filter: Annotated[
        Literal["pending", "approved", "rejected"] | None, Query(alias="status")
    ] = "pending",
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    cursor: str | None = None,
) -> CursorPage[AdminReviewView]:
    return await service.for_moderation(status=status_filter, limit=limit, cursor=cursor)


@router.patch("/reviews/{review_id}", response_model=AdminReviewView, summary="Approve or reject")
async def moderate_review(
    review_id: uuid.UUID, body: ReviewModeration, actor: CatalogWriterDep, service: ReviewServiceDep
) -> AdminReviewView:
    return await service.moderate(review_id, body.status, actor)
