"""Shipping rates and tax for an address — the inputs the pricing engine needs.

**Shipping.** An address falls in every active zone whose ``country_codes``
contain its country and whose ``regions`` (if set) contain its region. The
engine then keeps the rates whose price and weight bands fit the cart.

**Tax** sits behind :class:`TaxProvider`, so a service such as Avalara or
TaxJar can replace the rules without the cart knowing. The default,
:class:`RulesTaxProvider`, reads ``tax_rates``: a rate matches when its country
equals the address's, and its region and postal prefix — where set — match
too. Of the matching rates, those with the highest ``priority`` apply (all of
them: a state rate and a city rate at the same priority both apply). Raising a
rate's priority lets a specific rule replace general ones.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Protocol

from sqlalchemy import any_, literal, select
from sqlalchemy.ext.asyncio import AsyncSession

from velo.domains.cart.pricing import ShippingOption, TaxRule
from velo.domains.shipping.models import ShippingRate, ShippingZone, TaxRate


@dataclass(frozen=True, slots=True)
class Address:
    """Where the order would go. Only what shipping and tax need."""

    country_code: str
    region: str | None = None
    postal_code: str | None = None

    def normalised(self) -> Address:
        return Address(
            country_code=self.country_code.strip().upper(),
            region=(self.region or "").strip().upper() or None,
            postal_code=(self.postal_code or "").strip().upper().replace(" ", "") or None,
        )


class TaxProvider(Protocol):
    async def rules_for(self, address: Address) -> list[TaxRule]: ...


class RulesTaxProvider:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def rules_for(self, address: Address) -> list[TaxRule]:
        address = address.normalised()
        rows = (
            await self._session.scalars(
                select(TaxRate).where(
                    TaxRate.is_active.is_(True), TaxRate.country_code == address.country_code
                )
            )
        ).all()
        matching = [
            row
            for row in rows
            if (row.region is None or row.region.upper() == address.region)
            and (
                row.postal_prefix is None
                or (address.postal_code or "").startswith(
                    row.postal_prefix.upper().replace(" ", "")
                )
            )
        ]
        if not matching:
            return []
        top = max(row.priority for row in matching)
        return [
            TaxRule(id=row.id, name=row.name, rate=row.rate, inclusive=row.is_inclusive)
            for row in matching
            if row.priority == top
        ]


class ShippingService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def options_for(self, address: Address, currency: str) -> list[ShippingOption]:
        address = address.normalised()
        zones = (
            await self._session.scalars(
                select(ShippingZone).where(
                    ShippingZone.is_active.is_(True),
                    literal(address.country_code) == any_(ShippingZone.country_codes),
                )
            )
        ).all()
        zone_ids: list[uuid.UUID] = [
            zone.id
            for zone in zones
            if not zone.regions or (address.region or "") in {r.upper() for r in zone.regions}
        ]
        if not zone_ids:
            return []
        rates = (
            await self._session.scalars(
                select(ShippingRate)
                .where(
                    ShippingRate.zone_id.in_(zone_ids),
                    ShippingRate.is_active.is_(True),
                    ShippingRate.currency == currency,
                )
                .order_by(ShippingRate.position)
            )
        ).all()
        return [
            ShippingOption(
                id=rate.id,
                name=rate.name,
                price=rate.price_amount,
                min_subtotal=rate.min_subtotal_amount,
                max_subtotal=rate.max_subtotal_amount,
                min_weight_grams=rate.min_weight_grams,
                max_weight_grams=rate.max_weight_grams,
                position=rate.position,
                est_days_min=rate.est_days_min,
                est_days_max=rate.est_days_max,
            )
            for rate in rates
        ]
