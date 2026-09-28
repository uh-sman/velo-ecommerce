"""Public catalog — /products, /collections, /categories (API-SPEC.md §2, "Catalog")."""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Query, Response, status

from velo.api.deps import (
    AuthServiceDep,
    CatalogServiceDep,
    InventoryServiceDep,
    OptionalPrincipalDep,
    PrincipalDep,
    ReviewServiceDep,
)
from velo.core.errors import FieldError, ValidationError
from velo.core.pagination import DEFAULT_LIMIT, MAX_LIMIT, CursorPage
from velo.domains.catalog.schemas import BackInStockRequest, ReviewCreate, ReviewView
from velo.domains.catalog.service import ListingQuery
from velo.domains.catalog.views import (
    CategoryNode,
    CategoryPage,
    CollectionPage,
    CollectionView,
    ProductCard,
    ProductDetail,
)

router = APIRouter(tags=["catalog"])

Limit = Annotated[int, Query(ge=1, le=MAX_LIMIT)]
Sort = Literal["newest", "price", "-price", "rating"]
# Browsers and CDNs may keep public catalog reads briefly; the API's own cache
# is invalidated on write, this only saves round trips.
PUBLIC_CACHE = "public, max-age=30, stale-while-revalidate=60"


def _listing(
    *,
    category: str | None = None,
    collection: str | None = None,
    brand: list[str] | None = None,
    min_price: int | None = None,
    max_price: int | None = None,
    in_stock: bool | None = None,
    sort: Sort = "newest",
    limit: int = DEFAULT_LIMIT,
    cursor: str | None = None,
) -> ListingQuery:
    return ListingQuery(
        category=category,
        collection=collection,
        brands=tuple(sorted(set(brand or []))),
        min_price=min_price,
        max_price=max_price,
        in_stock=in_stock,
        sort=sort,
        limit=limit,
        cursor=cursor,
    )


@router.get("/products", response_model=CursorPage[ProductCard], summary="List products")
async def list_products(
    service: CatalogServiceDep,
    response: Response,
    category: str | None = None,
    collection: str | None = None,
    brand: Annotated[list[str] | None, Query(description="Repeat for several brands.")] = None,
    min_price: Annotated[int | None, Query(ge=0, description="Minor units.")] = None,
    max_price: Annotated[int | None, Query(ge=0, description="Minor units.")] = None,
    in_stock: bool | None = None,
    sort: Sort = "newest",
    limit: Limit = DEFAULT_LIMIT,
    cursor: str | None = None,
) -> CursorPage[ProductCard]:
    response.headers["Cache-Control"] = PUBLIC_CACHE
    return await service.list_products(
        _listing(
            category=category,
            collection=collection,
            brand=brand,
            min_price=min_price,
            max_price=max_price,
            in_stock=in_stock,
            sort=sort,
            limit=limit,
            cursor=cursor,
        )
    )


@router.get("/products/{slug}", response_model=ProductDetail, summary="Product detail")
async def get_product(slug: str, service: CatalogServiceDep, response: Response) -> ProductDetail:
    response.headers["Cache-Control"] = PUBLIC_CACHE
    return await service.product(slug)


@router.get(
    "/products/{slug}/related", response_model=list[ProductCard], summary="Related products"
)
async def related_products(slug: str, service: CatalogServiceDep) -> list[ProductCard]:
    return await service.related(slug)


@router.get(
    "/products/{slug}/reviews", response_model=CursorPage[ReviewView], summary="Approved reviews"
)
async def list_reviews(
    slug: str,
    service: ReviewServiceDep,
    limit: Limit = 10,
    cursor: str | None = None,
) -> CursorPage[ReviewView]:
    return await service.approved(slug, limit=limit, cursor=cursor)


@router.post(
    "/products/{slug}/reviews",
    response_model=ReviewView,
    status_code=status.HTTP_201_CREATED,
    summary="Submit a review (published after moderation)",
)
async def submit_review(
    slug: str, body: ReviewCreate, principal: PrincipalDep, service: ReviewServiceDep
) -> ReviewView:
    return await service.submit(slug, principal.user_id, body)


@router.post(
    "/products/{slug}/back-in-stock",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Email me when this variant is back in stock",
)
async def back_in_stock(
    slug: str,
    body: BackInStockRequest,
    principal: OptionalPrincipalDep,
    catalog: CatalogServiceDep,
    inventory: InventoryServiceDep,
    auth: AuthServiceDep,
) -> dict[str, str]:
    variant_id = await catalog.variant_of(slug, body.variant_id)
    email = str(body.email) if body.email else None
    if email is None:
        if principal is None:
            raise ValidationError(
                "Give an email address, or sign in.",
                errors=[FieldError(field="email", code="required", message="Required.")],
            )
        email = (await auth.get_user(principal.user_id)).email
    await inventory.subscribe(variant_id, email, principal.user_id if principal else None)
    return {"status": "subscribed"}


@router.get("/collections", response_model=list[CollectionView], summary="Active collections")
async def list_collections(service: CatalogServiceDep, response: Response) -> list[CollectionView]:
    response.headers["Cache-Control"] = PUBLIC_CACHE
    return await service.collections()


@router.get(
    "/collections/{slug}", response_model=CollectionPage, summary="A collection with its products"
)
async def get_collection(
    slug: str,
    service: CatalogServiceDep,
    sort: Sort = "newest",
    limit: Limit = DEFAULT_LIMIT,
    cursor: str | None = None,
) -> CollectionPage:
    collection = await service.collection(slug)
    products = await service.list_products(
        _listing(collection=slug, sort=sort, limit=limit, cursor=cursor)
    )
    return CollectionPage(collection=collection, products=products)


@router.get("/categories", response_model=list[CategoryNode], summary="The category tree")
async def category_tree(service: CatalogServiceDep, response: Response) -> list[CategoryNode]:
    response.headers["Cache-Control"] = PUBLIC_CACHE
    return await service.category_tree()


@router.get(
    "/categories/{slug}",
    response_model=CategoryPage,
    summary="A category with its products, including its descendants'",
)
async def get_category(
    slug: str,
    service: CatalogServiceDep,
    brand: Annotated[list[str] | None, Query()] = None,
    min_price: Annotated[int | None, Query(ge=0)] = None,
    max_price: Annotated[int | None, Query(ge=0)] = None,
    in_stock: bool | None = None,
    sort: Sort = "newest",
    limit: Limit = DEFAULT_LIMIT,
    cursor: str | None = None,
) -> CategoryPage:
    category, breadcrumbs, children = await service.category(slug)
    products = await service.list_products(
        _listing(
            category=slug,
            brand=brand,
            min_price=min_price,
            max_price=max_price,
            in_stock=in_stock,
            sort=sort,
            limit=limit,
            cursor=cursor,
        )
    )
    return CategoryPage(
        category=category, breadcrumbs=breadcrumbs, children=children, products=products
    )
