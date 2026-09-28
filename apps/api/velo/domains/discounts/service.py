"""Which discounts a customer may use right now — the half of eligibility the
pricing engine does not see.

The engine checks what depends on the cart (minimum subtotal, targets, item
counts). This service checks what depends on the customer and the calendar:
active, inside its date window, under its total and per-customer limits, the
first order if it must be, and the customer's segment.

A guest's order history is unknown until checkout, when the email is. A
first-order-only discount is therefore *provisionally* allowed for a guest and
checked again at checkout (Phase 8) — never silently granted.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum

from sqlalchemy import column, func, or_, select, table
from sqlalchemy.ext.asyncio import AsyncSession

from velo.domains.cart.pricing import Discount as PricingDiscount
from velo.domains.discounts.models import Discount, DiscountRedemption
from velo.domains.identity.permissions import is_staff

# Other domains' tables, read-only: how many paid orders a customer has, and
# the account facts segments depend on.
_orders = table("orders", column("user_id"), column("status"))
_users = table("users", column("id"), column("role"), column("marketing_opt_in"))
PAID_STATUSES = (
    "paid",
    "processing",
    "partially_fulfilled",
    "fulfilled",
    "delivered",
    "partially_refunded",
)


class CodeProblem(StrEnum):
    """Why a code cannot be used by this customer now. Shown to the customer."""

    UNKNOWN = "unknown"
    NOT_STARTED = "not_started"
    EXPIRED = "expired"
    USED_UP = "used_up"
    ALREADY_USED = "already_used"
    FIRST_ORDER_ONLY = "first_order_only"
    NOT_ELIGIBLE = "not_eligible"  # outside the discount's customer segment


MESSAGES = {
    CodeProblem.UNKNOWN: "That code is not valid.",
    CodeProblem.NOT_STARTED: "That code is not active yet.",
    CodeProblem.EXPIRED: "That code has expired.",
    CodeProblem.USED_UP: "That code has been fully redeemed.",
    CodeProblem.ALREADY_USED: "You have already used that code.",
    CodeProblem.FIRST_ORDER_ONLY: "That code is for a first order only.",
    CodeProblem.NOT_ELIGIBLE: "That code is not available on your account.",
}


@dataclass(frozen=True, slots=True)
class Customer:
    """What eligibility needs to know about whoever owns the cart."""

    user_id: uuid.UUID | None = None
    paid_orders: int = 0
    marketing_opt_in: bool = False
    is_staff: bool = False

    @property
    def is_guest(self) -> bool:
        return self.user_id is None


@dataclass(frozen=True, slots=True)
class Candidates:
    discounts: list[PricingDiscount]
    code_problem: CodeProblem | None  # set when a code was asked for and cannot be used


def to_pricing(row: Discount) -> PricingDiscount:
    return PricingDiscount(
        id=row.id,
        title=row.title,
        type=row.type,
        value=row.value,
        code=row.code,
        currency=row.currency,
        min_subtotal=row.min_subtotal_amount,
        applies_to=row.applies_to,
        target_ids=frozenset(row.target_ids or ()),
        stackable=row.is_stackable,
        buy_quantity=row.buy_quantity or 0,
        get_quantity=row.get_quantity or 0,
    )


class DiscountService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def customer(self, user_id: uuid.UUID | None) -> Customer:
        if user_id is None:
            return Customer()
        row = (
            await self._session.execute(
                select(_users.c.role, _users.c.marketing_opt_in).where(_users.c.id == user_id)
            )
        ).one_or_none()
        if row is None:
            return Customer()
        return Customer(
            user_id=user_id,
            paid_orders=await self.paid_order_count(user_id),
            marketing_opt_in=bool(row.marketing_opt_in),
            is_staff=is_staff(str(row.role)),
        )

    async def paid_order_count(self, user_id: uuid.UUID) -> int:
        count = await self._session.scalar(
            select(func.count())
            .select_from(_orders)
            .where(_orders.c.user_id == user_id, _orders.c.status.in_(PAID_STATUSES))
        )
        return int(count or 0)

    async def candidates(
        self, customer: Customer, *, code: str | None, now: datetime
    ) -> Candidates:
        """Automatic discounts, plus the code's, each checked against this customer."""
        query = select(Discount).where(Discount.is_active.is_(True))
        query = query.where(
            or_(Discount.code.is_(None), Discount.code == code) if code else Discount.code.is_(None)
        )
        rows = list((await self._session.scalars(query)).all())
        used = await self._redemptions(customer, [row.id for row in rows])

        allowed: list[PricingDiscount] = []
        problem: CodeProblem | None = CodeProblem.UNKNOWN if code else None
        for row in rows:
            reason = self._problem(row, customer, used.get(row.id, 0), now)
            is_code = row.code is not None
            if is_code:
                problem = reason
            if reason is None:
                allowed.append(to_pricing(row))
        return Candidates(discounts=allowed, code_problem=problem)

    async def _redemptions(
        self, customer: Customer, discount_ids: list[uuid.UUID]
    ) -> dict[uuid.UUID, int]:
        if customer.user_id is None or not discount_ids:
            return {}
        rows = (
            await self._session.execute(
                select(DiscountRedemption.discount_id, func.count())
                .where(
                    DiscountRedemption.user_id == customer.user_id,
                    DiscountRedemption.discount_id.in_(discount_ids),
                )
                .group_by(DiscountRedemption.discount_id)
            )
        ).all()
        return {discount_id: int(count) for discount_id, count in rows}

    @staticmethod
    def _problem(
        row: Discount, customer: Customer, used_by_customer: int, now: datetime
    ) -> CodeProblem | None:
        if row.starts_at > now:
            return CodeProblem.NOT_STARTED
        if row.ends_at is not None and row.ends_at <= now:
            return CodeProblem.EXPIRED
        if row.max_redemptions is not None and row.times_redeemed >= row.max_redemptions:
            return CodeProblem.USED_UP
        if row.max_per_customer is not None and used_by_customer >= row.max_per_customer:
            return CodeProblem.ALREADY_USED
        if row.first_order_only and not customer.is_guest and customer.paid_orders > 0:
            return CodeProblem.FIRST_ORDER_ONLY
        segment_ok = {
            "all": True,
            "returning": customer.paid_orders > 0,
            "subscribers": customer.marketing_opt_in,
            "staff": customer.is_staff,
        }.get(row.customer_segment, False)
        if not segment_ok:
            return CodeProblem.NOT_ELIGIBLE
        return None
