"""Product reviews: submit, moderate, aggregate.

- A review arrives ``pending`` and is invisible until a moderator approves it.
- One review per customer per product (a rejected one does not count).
- A paid order containing the product links the review to that order: the
  verified-purchase badge.
- The product's rating is denormalised (``rating_average``, ``rating_count``)
  and recomputed from approved reviews whenever a moderation decision lands.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from velo.core.errors import NotFoundError
from velo.core.jobs import JobQueue, NullJobQueue
from velo.core.pagination import CursorPage, PaginationInfo, decode_cursor, encode_cursor
from velo.domains.catalog.cache import CatalogCache
from velo.domains.catalog.exceptions import AlreadyReviewedError
from velo.domains.catalog.repository import CatalogRepository, ReviewRecord
from velo.domains.catalog.schemas import AdminReviewView, ReviewCreate, ReviewView
from velo.domains.platform.events import Actor, record_audit, record_event


def _view(review: ReviewRecord) -> ReviewView:
    return ReviewView(
        id=review.id,
        rating=review.rating,
        title=review.title,
        body=review.body,
        author=review.author_name,
        verified_purchase=review.order_id is not None,
        created_at=review.created_at,
    )


def _admin_view(review: ReviewRecord) -> AdminReviewView:
    return AdminReviewView(
        **_view(review).model_dump(),
        product_id=review.product_id,
        user_id=review.user_id,
        status=review.status,
    )


def _page_cursor(sort: str, items: list[ReviewRecord], has_more: bool) -> str | None:
    return encode_cursor(sort, items[-1].created_at, items[-1].id) if has_more and items else None


class ReviewService:
    def __init__(
        self, session: AsyncSession, cache: CatalogCache, jobs: JobQueue | None = None
    ) -> None:
        self._session = session
        self._catalog = CatalogRepository(session)
        self._cache = cache
        self._jobs = jobs or NullJobQueue()

    async def approved(
        self, slug: str, *, limit: int, cursor: str | None
    ) -> CursorPage[ReviewView]:
        product = await self._catalog.product_by_slug(slug)
        if product is None:
            raise NotFoundError("No such product.")
        after: tuple[datetime, uuid.UUID] | None = (
            decode_cursor(cursor, "reviews") if cursor else None
        )
        items, has_more = await self._catalog.approved_reviews(product.id, limit=limit, after=after)
        return CursorPage[ReviewView](
            data=[_view(item) for item in items],
            pagination=PaginationInfo(
                next_cursor=_page_cursor("reviews", items, has_more), has_more=has_more, limit=limit
            ),
        )

    async def submit(self, slug: str, user_id: uuid.UUID, body: ReviewCreate) -> ReviewView:
        product = await self._catalog.product_by_slug(slug)
        if product is None:
            raise NotFoundError("No such product.")
        if await self._catalog.user_has_reviewed(user_id, product.id):
            raise AlreadyReviewedError("Edit requests go to support; one review per product.")
        review = await self._catalog.create_review(
            product_id=product.id,
            user_id=user_id,
            order_id=await self._catalog.verified_order_for(user_id, product.id),
            rating=body.rating,
            title=body.title or None,
            body=body.body or None,
            status="pending",
        )
        await self._session.commit()
        return _view(review)

    async def for_moderation(
        self, *, status: str | None, limit: int, cursor: str | None
    ) -> CursorPage[AdminReviewView]:
        after = decode_cursor(cursor, "admin-reviews") if cursor else None
        items, has_more = await self._catalog.reviews_for_moderation(
            status=status, limit=limit, after=after
        )
        return CursorPage[AdminReviewView](
            data=[_admin_view(item) for item in items],
            pagination=PaginationInfo(
                next_cursor=_page_cursor("admin-reviews", items, has_more),
                has_more=has_more,
                limit=limit,
            ),
        )

    async def moderate(self, review_id: uuid.UUID, status: str, actor: Actor) -> AdminReviewView:
        review = await self._catalog.review(review_id)
        if review is None:
            raise NotFoundError("No such review.")
        if review.status != status:
            await self._catalog.set_review_status(review_id, status)
            await self._catalog.refresh_rating(review.product_id)
            record_audit(
                self._session,
                actor,
                f"review.{status}",
                "review",
                review_id,
                {"status": {"from": review.status, "to": status}},
            )
            # The rating is in the search document and on the product page.
            product = await self._catalog.product_by_id(review.product_id)
            record_event(
                self._session,
                "product",
                review.product_id,
                "product.updated",
                {"slug": product.slug if product else None},
            )
            await self._session.commit()
            if product is not None:
                await self._cache.invalidate_product(product.slug)
            await self._cache.bump()
            await self._jobs.kick_outbox()
        updated = await self._catalog.review(review_id)
        assert updated is not None
        return _admin_view(updated)
