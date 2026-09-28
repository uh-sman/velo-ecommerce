"""/search — full-text search with facets, and autocomplete (API-SPEC.md §2, "Search")."""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Response

from velo.api.deps import ClientDep, SearchServiceDep, get_rate_limiter
from velo.core import rate_limit
from velo.core.errors import RateLimitedError
from velo.core.pagination import MAX_LIMIT
from velo.core.rate_limit import RateLimiter
from velo.domains.catalog.search import SearchQuery, SearchResults, Suggestion

router = APIRouter(prefix="/search", tags=["search"])

Values = Annotated[list[str] | None, Query(description="Repeat for several values.")]


async def search_rate_limit(
    client: ClientDep,
    response: Response,
    limiter: Annotated[RateLimiter, Depends(get_rate_limiter)],
) -> None:
    status = await limiter.hit(rate_limit.SEARCH_PER_IP, client.ip)
    if not status.allowed:
        raise RateLimitedError("Searching too fast. Wait a moment.", headers=status.headers())
    response.headers.update(status.headers())


RateLimited = Depends(search_rate_limit)


@router.get("", response_model=SearchResults, summary="Search products", dependencies=[RateLimited])
async def search(
    service: SearchServiceDep,
    q: Annotated[str, Query(max_length=200)] = "",
    brand: Values = None,
    category: Values = None,
    collection: Values = None,
    colour: Values = None,
    size: Values = None,
    min_price: Annotated[int | None, Query(ge=0, description="Minor units.")] = None,
    max_price: Annotated[int | None, Query(ge=0, description="Minor units.")] = None,
    in_stock: bool | None = None,
    sort: Literal["relevance", "price", "-price", "newest", "rating"] = "relevance",
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = 24,
    offset: Annotated[int, Query(ge=0, le=4900)] = 0,
) -> SearchResults:
    return await service.search(
        SearchQuery(
            q=q.strip(),
            brands=tuple(brand or ()),
            categories=tuple(category or ()),
            collections=tuple(collection or ()),
            colours=tuple(colour or ()),
            sizes=tuple(size or ()),
            min_price=min_price,
            max_price=max_price,
            in_stock=in_stock,
            sort=sort,
            limit=limit,
            offset=offset,
        )
    )


@router.get(
    "/suggest",
    response_model=list[Suggestion],
    summary="Autocomplete: up to 8 products",
    dependencies=[RateLimited],
)
async def suggest(
    service: SearchServiceDep, q: Annotated[str, Query(max_length=100)] = ""
) -> list[Suggestion]:
    return await service.suggest(q)
