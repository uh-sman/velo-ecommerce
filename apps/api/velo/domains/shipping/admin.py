"""Shipping zones, rates and tax rates, edited from the admin (PLANNING.md Phase 11).

Checkout reads these live (shipping/service.py), so an edit applies to the
next cart priced. Rows are deactivated rather than deleted while anything
could still refer to them: a rate chosen by a checkout in progress must still
resolve when that checkout is paid.
"""

from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from velo.core.errors import FieldError, NotFoundError, ValidationError
from velo.domains.platform.events import Actor, diff, record_audit
from velo.domains.shipping.models import ShippingRate, ShippingZone, TaxRate

ZONE_FIELDS = ("name", "country_codes", "regions", "is_active")
RATE_FIELDS = (
    "name",
    "description",
    "price_amount",
    "currency",
    "min_subtotal_amount",
    "max_subtotal_amount",
    "min_weight_grams",
    "max_weight_grams",
    "est_days_min",
    "est_days_max",
    "is_active",
    "position",
)
TAX_FIELDS = ("name", "country_code", "region", "postal_prefix", "rate", "is_inclusive",
              "priority", "is_active")  # fmt: skip


def _plain(values: dict[str, Any]) -> dict[str, Any]:
    return {k: (str(v) if isinstance(v, Decimal | uuid.UUID) else v) for k, v in values.items()}


def _check_rate(fields: dict[str, Any]) -> None:
    errors: list[FieldError] = []
    if int(fields.get("price_amount", 0)) < 0:
        errors.append(FieldError(field="price_amount", code="invalid", message="Not negative."))
    low, high = fields.get("min_subtotal_amount"), fields.get("max_subtotal_amount")
    if low is not None and high is not None and high < low:
        errors.append(
            FieldError(field="max_subtotal_amount", code="invalid", message="Below the minimum.")
        )
    low, high = fields.get("est_days_min"), fields.get("est_days_max")
    if low is not None and high is not None and high < low:
        errors.append(
            FieldError(field="est_days_max", code="invalid", message="Below the minimum.")
        )
    if errors:
        raise ValidationError("Check the highlighted fields.", errors=errors)


class ShippingAdminService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    # ── Zones and their rates ─────────────────────────────────────────────

    async def zones(self) -> list[tuple[ShippingZone, list[ShippingRate]]]:
        zones = (
            await self._session.scalars(select(ShippingZone).order_by(ShippingZone.name))
        ).all()
        rates = (
            await self._session.scalars(
                select(ShippingRate).order_by(ShippingRate.position, ShippingRate.price_amount)
            )
        ).all()
        by_zone: dict[uuid.UUID, list[ShippingRate]] = {}
        for rate in rates:
            by_zone.setdefault(rate.zone_id, []).append(rate)
        return [(zone, by_zone.get(zone.id, [])) for zone in zones]

    async def create_zone(self, fields: dict[str, Any], actor: Actor) -> ShippingZone:
        fields = {k: v for k, v in fields.items() if k in ZONE_FIELDS}
        fields["country_codes"] = [c.upper() for c in fields.get("country_codes", [])]
        if not fields["country_codes"]:
            raise ValidationError(
                "A zone needs at least one country.",
                errors=[
                    FieldError(field="country_codes", code="missing", message="Add a country.")
                ],
            )
        zone = ShippingZone(**fields)
        self._session.add(zone)
        await self._session.flush()
        record_audit(
            self._session, actor, "shipping.zone_created", "shipping_zone", zone.id, _plain(fields)
        )
        await self._session.commit()
        return zone

    async def update_zone(
        self, zone_id: uuid.UUID, changes: dict[str, Any], actor: Actor
    ) -> ShippingZone:
        zone = await self._session.get(ShippingZone, zone_id, with_for_update=True)
        if zone is None:
            raise NotFoundError("No such zone.")
        before = {k: getattr(zone, k) for k in ZONE_FIELDS}
        for key, value in changes.items():
            if key in ZONE_FIELDS:
                setattr(zone, key, [c.upper() for c in value] if key == "country_codes" else value)
        record_audit(
            self._session,
            actor,
            "shipping.zone_updated",
            "shipping_zone",
            zone.id,
            diff(_plain(before), _plain({k: getattr(zone, k) for k in ZONE_FIELDS})),
        )
        await self._session.commit()
        return zone

    async def create_rate(
        self, zone_id: uuid.UUID, fields: dict[str, Any], actor: Actor
    ) -> ShippingRate:
        if await self._session.get(ShippingZone, zone_id) is None:
            raise NotFoundError("No such zone.")
        fields = {k: v for k, v in fields.items() if k in RATE_FIELDS}
        _check_rate(fields)
        rate = ShippingRate(zone_id=zone_id, **fields)
        self._session.add(rate)
        await self._session.flush()
        record_audit(
            self._session, actor, "shipping.rate_created", "shipping_rate", rate.id, _plain(fields)
        )
        await self._session.commit()
        return rate

    async def update_rate(
        self, rate_id: uuid.UUID, changes: dict[str, Any], actor: Actor
    ) -> ShippingRate:
        rate = await self._session.get(ShippingRate, rate_id, with_for_update=True)
        if rate is None:
            raise NotFoundError("No such rate.")
        before = {k: getattr(rate, k) for k in RATE_FIELDS}
        merged = {**before, **{k: v for k, v in changes.items() if k in RATE_FIELDS}}
        _check_rate(merged)
        for key, value in merged.items():
            setattr(rate, key, value)
        record_audit(
            self._session,
            actor,
            "shipping.rate_updated",
            "shipping_rate",
            rate.id,
            diff(_plain(before), _plain(merged)),
        )
        await self._session.commit()
        return rate

    # ── Tax ───────────────────────────────────────────────────────────────

    async def tax_rates(self) -> list[TaxRate]:
        return list(
            (
                await self._session.scalars(
                    select(TaxRate).order_by(TaxRate.country_code, TaxRate.region, TaxRate.priority)
                )
            ).all()
        )

    async def create_tax(self, fields: dict[str, Any], actor: Actor) -> TaxRate:
        fields = {k: v for k, v in fields.items() if k in TAX_FIELDS}
        fields["country_code"] = str(fields.get("country_code", "")).upper()
        self._check_tax(fields)
        rate = TaxRate(**fields)
        self._session.add(rate)
        await self._session.flush()
        record_audit(self._session, actor, "tax.created", "tax_rate", rate.id, _plain(fields))
        await self._session.commit()
        return rate

    async def update_tax(self, tax_id: uuid.UUID, changes: dict[str, Any], actor: Actor) -> TaxRate:
        rate = await self._session.get(TaxRate, tax_id, with_for_update=True)
        if rate is None:
            raise NotFoundError("No such tax rate.")
        before = {k: getattr(rate, k) for k in TAX_FIELDS}
        merged = {**before, **{k: v for k, v in changes.items() if k in TAX_FIELDS}}
        self._check_tax(merged)
        for key, value in merged.items():
            setattr(rate, key, value)
        record_audit(
            self._session,
            actor,
            "tax.updated",
            "tax_rate",
            rate.id,
            diff(_plain(before), _plain(merged)),
        )
        await self._session.commit()
        return rate

    @staticmethod
    def _check_tax(fields: dict[str, Any]) -> None:
        rate = Decimal(str(fields.get("rate", 0)))
        if not (0 <= rate <= 1):
            raise ValidationError(
                "A tax rate is a fraction: 0.0725 is 7.25%.",
                errors=[FieldError(field="rate", code="invalid", message="Between 0 and 1.")],
            )
        if len(str(fields.get("country_code", ""))) != 2:
            raise ValidationError(
                "Use a two-letter country code.",
                errors=[FieldError(field="country_code", code="invalid", message="Two letters.")],
            )
