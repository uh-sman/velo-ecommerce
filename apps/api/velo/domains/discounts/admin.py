"""The discount builder (PLANNING.md Phase 11): create, edit, retire, and test discounts.

**Testing a rule before it goes live.** ``preview`` prices a sample basket
with the draft discount through the same pure engine checkout uses
(cart/pricing.py) and checks the customer rules with the same function
(DiscountService._problem). What the tester says is what checkout will do.

**Retiring.** A discount that has been redeemed is deactivated, not deleted:
its redemptions are part of order history. One never used is deleted.

Validation mirrors the table's CHECK constraints so an operator reads a
sentence, not a constraint name.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from velo.core.errors import ConflictError, FieldError, NotFoundError, ValidationError
from velo.domains.cart.pricing import Line, PricingInput, price_cart
from velo.domains.catalog.repository import CatalogRepository
from velo.domains.discounts.models import (
    CUSTOMER_SEGMENTS,
    DISCOUNT_TARGETS,
    DISCOUNT_TYPES,
    Discount,
)
from velo.domains.discounts.service import MESSAGES, DiscountService, to_pricing
from velo.domains.identity.models import User
from velo.domains.platform.events import Actor, diff, record_audit

EDITABLE = (
    "code",
    "title",
    "type",
    "value",
    "currency",
    "min_subtotal_amount",
    "applies_to",
    "target_ids",
    "first_order_only",
    "max_redemptions",
    "max_per_customer",
    "is_stackable",
    "starts_at",
    "ends_at",
    "is_active",
    "buy_quantity",
    "get_quantity",
    "customer_segment",
)


def status_of(row: Discount, now: datetime) -> str:
    if not row.is_active:
        return "inactive"
    if row.starts_at > now:
        return "scheduled"
    if row.ends_at is not None and row.ends_at <= now:
        return "expired"
    if row.max_redemptions is not None and row.times_redeemed >= row.max_redemptions:
        return "used_up"
    return "active"


def validate(fields: dict[str, Any]) -> None:
    """The rules a discount must satisfy, as field errors."""
    errors: list[FieldError] = []

    def bad(name: str, message: str) -> None:
        errors.append(FieldError(field=name, code="invalid", message=message))

    kind = fields.get("type")
    value = Decimal(str(fields.get("value", 0)))
    if kind not in DISCOUNT_TYPES:
        bad("type", f"Choose one of: {', '.join(DISCOUNT_TYPES)}.")
    if kind in ("percentage", "buy_x_get_y") and not (0 < value <= 100):
        bad("value", "A percentage is more than 0 and at most 100.")
    if kind == "fixed_amount":
        if value <= 0:
            bad("value", "The amount off must be more than zero.")
        if not fields.get("currency"):
            bad("currency", "A fixed amount needs a currency.")
    if kind == "buy_x_get_y" and (
        int(fields.get("buy_quantity") or 0) < 1 or int(fields.get("get_quantity") or 0) < 1
    ):
        bad("buy_quantity", "Buy X get Y needs at least 1 to buy and 1 to get.")
    if fields.get("applies_to", "all") not in DISCOUNT_TARGETS:
        bad("applies_to", f"Choose one of: {', '.join(DISCOUNT_TARGETS)}.")
    if fields.get("applies_to", "all") != "all" and not fields.get("target_ids"):
        bad("target_ids", "Choose at least one product or collection.")
    if fields.get("customer_segment", "all") not in CUSTOMER_SEGMENTS:
        bad("customer_segment", f"Choose one of: {', '.join(CUSTOMER_SEGMENTS)}.")
    starts, ends = fields.get("starts_at"), fields.get("ends_at")
    if starts and ends and ends <= starts:
        bad("ends_at", "The end must be after the start.")
    for name in ("max_redemptions", "max_per_customer", "min_subtotal_amount"):
        if fields.get(name) is not None and int(fields[name]) < 0:
            bad(name, "Must not be negative.")
    if errors:
        raise ValidationError("Check the highlighted fields.", errors=errors)


@dataclass(frozen=True, slots=True)
class SampleLine:
    variant_id: uuid.UUID
    quantity: int


@dataclass(frozen=True, slots=True)
class Preview:
    eligible: bool
    customer_problem: str | None  # why this customer could not use it (a customer-facing sentence)
    cart_problem: str | None  # why this basket does not qualify (Ineligible code)
    currency: str
    subtotal: int
    discount: int
    shipping_discounted: bool
    total: int
    lines: list[dict[str, Any]] = field(default_factory=list)


class DiscountAdminService:
    def __init__(self, session: AsyncSession, *, currency: str) -> None:
        self._session = session
        self._currency = currency
        self._catalog = CatalogRepository(session)

    async def search(self, *, query: str | None, status: str | None) -> list[tuple[Discount, str]]:
        statement = select(Discount)
        if query:
            like = f"%{query.strip()}%"
            statement = statement.where(or_(Discount.code.ilike(like), Discount.title.ilike(like)))
        rows = (await self._session.scalars(statement.order_by(Discount.created_at.desc()))).all()
        now = datetime.now(UTC)
        found = [(row, status_of(row, now)) for row in rows]
        return [item for item in found if status is None or item[1] == status]

    async def get(self, discount_id: uuid.UUID) -> tuple[Discount, str]:
        row = await self._session.get(Discount, discount_id)
        if row is None:
            raise NotFoundError("No such discount.")
        return row, status_of(row, datetime.now(UTC))

    async def create(self, fields: dict[str, Any], actor: Actor) -> Discount:
        fields = {key: value for key, value in fields.items() if key in EDITABLE}
        fields.setdefault("starts_at", datetime.now(UTC))
        validate(fields)
        row = Discount(**fields)
        self._session.add(row)
        await self._flush_unique(fields.get("code"))
        record_audit(
            self._session,
            actor,
            "discount.created",
            "discount",
            row.id,
            {
                "code": row.code,
                "type": row.type,
                "value": str(row.value),
            },
        )
        await self._session.commit()
        await self._session.refresh(row)
        return row

    async def update(
        self, discount_id: uuid.UUID, changes: dict[str, Any], actor: Actor
    ) -> Discount:
        row = await self._session.get(Discount, discount_id, with_for_update=True)
        if row is None:
            raise NotFoundError("No such discount.")
        before = {key: getattr(row, key) for key in EDITABLE}
        merged = {**before, **{k: v for k, v in changes.items() if k in EDITABLE}}
        validate(merged)
        if row.times_redeemed > 0:
            # Redemptions recorded what it was: the terms that priced them stay.
            locked = ("type", "value", "currency", "applies_to", "target_ids", "buy_quantity",
                      "get_quantity")  # fmt: skip
            changed = [k for k in locked if k in changes and changes[k] != before[k]]
            if changed:
                raise ConflictError(
                    "This discount has been used, so its terms cannot change. Deactivate it and "
                    "create a new one.",
                    errors=[
                        FieldError(field=k, code="locked", message="Fixed once redeemed.")
                        for k in changed
                    ],
                )
        for key, value in merged.items():
            setattr(row, key, value)
        await self._flush_unique(merged.get("code"))
        record_audit(
            self._session,
            actor,
            "discount.updated",
            "discount",
            row.id,
            diff(
                {k: _plain(v) for k, v in before.items()}, {k: _plain(v) for k, v in merged.items()}
            ),
        )
        await self._session.commit()
        await self._session.refresh(row)
        return row

    async def retire(self, discount_id: uuid.UUID, actor: Actor) -> str:
        """``deleted`` if never used; otherwise ``deactivated``."""
        row = await self._session.get(Discount, discount_id, with_for_update=True)
        if row is None:
            raise NotFoundError("No such discount.")
        if row.times_redeemed > 0:
            row.is_active = False
            outcome = "deactivated"
        else:
            await self._session.delete(row)
            outcome = "deleted"
        record_audit(
            self._session, actor, f"discount.{outcome}", "discount", discount_id, {"code": row.code}
        )
        await self._session.commit()
        return outcome

    async def preview(
        self,
        draft: dict[str, Any],
        lines: list[SampleLine],
        *,
        customer_email: str | None,
    ) -> Preview:
        fields = {key: value for key, value in draft.items() if key in EDITABLE}
        fields.setdefault("starts_at", datetime.now(UTC))
        fields.setdefault("is_active", True)
        fields.setdefault("applies_to", "all")
        fields.setdefault("customer_segment", "all")
        validate(fields)
        row = Discount(id=uuid.uuid4(), times_redeemed=0, **fields)  # transient, never added

        discounts = DiscountService(self._session)
        user_id = None
        if customer_email:
            # CITEXT: the comparison ignores case.
            user_id = await self._session.scalar(
                select(User.id).where(User.email == customer_email)
            )
        customer = await discounts.customer(user_id, email=customer_email)
        problem = DiscountService._problem(row, customer, 0, datetime.now(UTC))

        snapshots = await self._catalog.variant_snapshots([line.variant_id for line in lines])
        priced_lines = [
            Line(
                id=line.variant_id,
                product_id=snapshot.product_id,
                unit_price=snapshot.price_amount,
                quantity=line.quantity,
                collection_ids=snapshot.collection_ids,
                weight_grams=snapshot.weight_grams,
                taxable=snapshot.is_taxable,
                requires_shipping=snapshot.requires_shipping,
            )
            for line in lines
            if (snapshot := snapshots.get(line.variant_id)) is not None
        ]
        if not priced_lines:
            raise ValidationError("Add at least one product to the test basket.")
        result = price_cart(
            PricingInput(
                currency=self._currency,
                lines=priced_lines,
                discounts=[] if problem else [to_pricing(row)],
                applied_code=row.code,
            )
        )
        rejected = result.rejected.get(row.id)
        applied = next((d for d in result.discounts if d.id == row.id), None)
        titles = {
            line.variant_id: snapshots[line.variant_id]
            for line in lines
            if line.variant_id in snapshots
        }
        return Preview(
            eligible=problem is None and applied is not None,
            customer_problem=MESSAGES[problem] if problem else None,
            cart_problem=rejected.value if rejected else None,
            currency=result.currency,
            subtotal=result.subtotal,
            discount=applied.amount if applied else 0,
            shipping_discounted=row.type == "free_shipping" and applied is not None,
            total=result.subtotal - result.discount,
            lines=[
                {
                    "variant_id": str(priced.id),
                    "title": (
                        f"{titles[priced.id].product_title} — {titles[priced.id].variant_title}"
                    ),
                    "quantity": priced.quantity,
                    "subtotal": priced.subtotal,
                    "discount": priced.discount,
                }
                for priced in result.lines
            ],
        )

    async def _flush_unique(self, code: str | None) -> None:
        try:
            await self._session.flush()
        except IntegrityError as exc:
            await self._session.rollback()
            if "code" in str(exc.orig):
                raise ConflictError(
                    f"The code {code} is already in use.",
                    errors=[FieldError(field="code", code="taken", message="Already in use.")],
                ) from exc
            raise ValidationError("That discount breaks a rule; check the values.") from exc


def _plain(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, list):
        return [str(item) for item in value]
    return value
