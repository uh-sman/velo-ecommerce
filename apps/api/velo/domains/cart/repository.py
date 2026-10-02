"""Cart data access. Queries in, frozen records out — no rules, no HTTP.

``checkout_sessions`` is named as a bare table clause, read-only: a cart a
checkout was made from is kept, because the session (and its order) refer to
it (ARCHITECTURE.md §3, rule 5).
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import column, delete, func, select, table, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from velo.domains.cart.models import Cart, CartItem

_checkouts = table("checkout_sessions", column("cart_id"))

LIVE_STATUSES = ("active", "abandoned")  # a cart its owner can still use


@dataclass(frozen=True, slots=True)
class CartRecord:
    id: uuid.UUID
    user_id: uuid.UUID | None
    currency: str
    status: str
    discount_code: str | None
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class ItemRecord:
    id: uuid.UUID
    variant_id: uuid.UUID
    quantity: int
    seen_price_amount: int | None
    created_at: datetime


def _cart(row: Cart) -> CartRecord:
    return CartRecord(
        id=row.id,
        user_id=row.user_id,
        currency=row.currency,
        status=row.status,
        discount_code=row.discount_code,
        updated_at=row.updated_at,
    )


def _item(row: CartItem) -> ItemRecord:
    return ItemRecord(
        id=row.id,
        variant_id=row.variant_id,
        quantity=row.quantity,
        seen_price_amount=row.seen_price_amount,
        created_at=row.created_at,
    )


class CartRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def for_user(self, user_id: uuid.UUID, *, lock: bool = False) -> CartRecord | None:
        query = (
            select(Cart)
            .where(Cart.user_id == user_id, Cart.status.in_(LIVE_STATUSES))
            # The active cart if there is one, else the most recent abandoned one.
            .order_by((Cart.status == "active").desc(), Cart.updated_at.desc())
            .limit(1)
        )
        if lock:
            query = query.with_for_update()
        row = await self._session.scalar(query.execution_options(populate_existing=True))
        return _cart(row) if row else None

    async def for_token(self, token_hash: str, *, lock: bool = False) -> CartRecord | None:
        query = select(Cart).where(
            Cart.guest_token == token_hash,
            Cart.user_id.is_(None),
            Cart.status.in_(LIVE_STATUSES),
            Cart.expires_at > func.now(),
        )
        if lock:
            query = query.with_for_update()
        row = await self._session.scalar(query.execution_options(populate_existing=True))
        return _cart(row) if row else None

    async def by_id(self, cart_id: uuid.UUID) -> CartRecord | None:
        row = await self._session.scalar(
            select(Cart).where(Cart.id == cart_id).execution_options(populate_existing=True)
        )
        return _cart(row) if row else None

    async def lock(self, cart_id: uuid.UUID) -> None:
        """Serialise mutations of one cart: two tabs adding at once must not race."""
        await self._session.execute(select(Cart.id).where(Cart.id == cart_id).with_for_update())

    async def create(
        self, *, user_id: uuid.UUID | None, token_hash: str | None, currency: str
    ) -> CartRecord:
        row = Cart(user_id=user_id, guest_token=token_hash, currency=currency)
        self._session.add(row)
        await self._session.flush()
        return _cart(row)

    async def touch(self, cart_id: uuid.UUID, ttl: timedelta) -> None:
        """A mutation: the cart is active again and its expiry slides forward."""
        await self._session.execute(
            update(Cart)
            .where(Cart.id == cart_id)
            .values(
                status="active",
                abandoned_at=None,
                expires_at=func.now() + ttl,
                updated_at=func.now(),
            )
        )

    async def set_code(self, cart_id: uuid.UUID, code: str | None) -> None:
        await self._session.execute(
            update(Cart).where(Cart.id == cart_id).values(discount_code=code)
        )

    async def claim(self, cart_id: uuid.UUID, user_id: uuid.UUID) -> None:
        """A guest cart becomes the user's: the token stops working."""
        await self._session.execute(
            update(Cart).where(Cart.id == cart_id).values(user_id=user_id, guest_token=None)
        )

    async def mark_merged(self, cart_id: uuid.UUID, user_id: uuid.UUID) -> None:
        await self._session.execute(
            update(Cart)
            .where(Cart.id == cart_id)
            .values(status="merged", user_id=user_id, guest_token=None, updated_at=func.now())
        )

    async def items(self, cart_id: uuid.UUID) -> list[ItemRecord]:
        rows = (
            await self._session.scalars(
                select(CartItem)
                .where(CartItem.cart_id == cart_id)
                .order_by(CartItem.created_at, CartItem.id)
                .execution_options(populate_existing=True)
            )
        ).all()
        return [_item(row) for row in rows]

    async def item(self, cart_id: uuid.UUID, item_id: uuid.UUID) -> ItemRecord | None:
        row = await self._session.scalar(
            select(CartItem)
            .where(CartItem.cart_id == cart_id, CartItem.id == item_id)
            .execution_options(populate_existing=True)
        )
        return _item(row) if row else None

    async def put_item(
        self, cart_id: uuid.UUID, variant_id: uuid.UUID, quantity: int, seen_price: int
    ) -> None:
        """Set the line for a variant to an absolute quantity, creating it if needed."""
        statement = insert(CartItem).values(
            cart_id=cart_id, variant_id=variant_id, quantity=quantity, seen_price_amount=seen_price
        )
        await self._session.execute(
            statement.on_conflict_do_update(
                index_elements=["cart_id", "variant_id"],
                set_={
                    "quantity": statement.excluded.quantity,
                    "seen_price_amount": statement.excluded.seen_price_amount,
                    "updated_at": func.now(),
                },
            )
        )

    async def delete_item(self, cart_id: uuid.UUID, item_id: uuid.UUID) -> None:
        await self._session.execute(
            delete(CartItem).where(CartItem.cart_id == cart_id, CartItem.id == item_id)
        )

    async def clear(self, cart_id: uuid.UUID) -> None:
        await self._session.execute(delete(CartItem).where(CartItem.cart_id == cart_id))

    async def reduce(self, cart_id: uuid.UUID, quantities: Mapping[uuid.UUID, int]) -> None:
        """Take these quantities off the cart's lines; a line reduced to nothing goes."""
        for variant_id, quantity in quantities.items():
            where = (CartItem.cart_id == cart_id, CartItem.variant_id == variant_id)
            await self._session.execute(
                delete(CartItem).where(*where, CartItem.quantity <= quantity)
            )
            await self._session.execute(
                update(CartItem)
                .where(*where)
                .values(quantity=CartItem.quantity - quantity, updated_at=func.now())
            )

    # ── Housekeeping ──────────────────────────────────────────────────────

    async def mark_abandoned(self, idle_since: datetime) -> int:
        """Active carts with items, untouched since ``idle_since``. Returns how many."""
        has_items = select(CartItem.id).where(CartItem.cart_id == Cart.id).exists()
        result = await self._session.execute(
            update(Cart)
            .where(Cart.status == "active", Cart.updated_at < idle_since, has_items)
            .values(status="abandoned", abandoned_at=func.now())
        )
        return int(result.rowcount or 0)  # type: ignore[attr-defined]

    async def delete_expired_guest_carts(self) -> int:
        """Guest carts past their expiry, unless a checkout was made from them.

        A user's cart is kept with the account.
        """
        checked_out = select(_checkouts.c.cart_id).where(_checkouts.c.cart_id == Cart.id).exists()
        result = await self._session.execute(
            delete(Cart).where(Cart.user_id.is_(None), Cart.expires_at < func.now(), ~checked_out)
        )
        return int(result.rowcount or 0)  # type: ignore[attr-defined]
