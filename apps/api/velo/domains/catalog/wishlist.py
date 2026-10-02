"""The wishlist — products a signed-in customer saved for later (PLANNING.md 10.5).

Adding is idempotent (saving twice is saving once) and removing something not
saved is not an error: the heart icon on a product card is a toggle, and a
double tap must not produce an error toast. Only published products can be
saved; one unpublished later simply drops out of the list.
"""

from __future__ import annotations

import uuid

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from velo.core.errors import NotFoundError
from velo.domains.catalog.models import Product, WishlistItem
from velo.domains.catalog.service import CatalogService
from velo.domains.catalog.views import ProductCard

# A wishlist is a list someone scrolls, not an archive.
MAX_ITEMS = 500


class WishlistService:
    def __init__(self, session: AsyncSession, catalog: CatalogService) -> None:
        self._session = session
        self._catalog = catalog

    async def product_ids(self, user_id: uuid.UUID) -> list[uuid.UUID]:
        rows = await self._session.scalars(
            select(WishlistItem.product_id)
            .where(WishlistItem.user_id == user_id)
            .order_by(WishlistItem.created_at.desc())
            .limit(MAX_ITEMS)
        )
        return list(rows.all())

    async def cards(self, user_id: uuid.UUID) -> list[ProductCard]:
        ids = await self.product_ids(user_id)
        cards = {card.id: card for card in await self._catalog.cards(ids)}
        return [cards[product_id] for product_id in ids if product_id in cards]

    async def add(self, user_id: uuid.UUID, product_id: uuid.UUID) -> None:
        published = await self._session.scalar(
            select(Product.id).where(
                Product.id == product_id,
                Product.status == "active",
                Product.deleted_at.is_(None),
            )
        )
        if published is None:
            raise NotFoundError("No such product.")
        await self._session.execute(
            insert(WishlistItem)
            .values(user_id=user_id, product_id=product_id)
            .on_conflict_do_nothing(index_elements=["user_id", "product_id"])
        )
        await self._session.commit()

    async def remove(self, user_id: uuid.UUID, product_id: uuid.UUID) -> None:
        await self._session.execute(
            delete(WishlistItem).where(
                WishlistItem.user_id == user_id, WishlistItem.product_id == product_id
            )
        )
        await self._session.commit()
