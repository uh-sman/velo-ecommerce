"""Shipping and tax tables — DATA-MODEL.md §9.

Tax rates live here because both are resolved from the same input, the
destination address.
"""

from __future__ import annotations

import uuid
from decimal import Decimal

from sqlalchemy import CHAR, CheckConstraint, ForeignKey, Index, Numeric, Text, text
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from velo.db.base import Base, HasId
from velo.db.types import MinorUnits


class ShippingZone(HasId, Base):
    __tablename__ = "shipping_zones"

    name: Mapped[str]
    country_codes: Mapped[list[str]] = mapped_column(ARRAY(CHAR(2)))
    regions: Mapped[list[str] | None] = mapped_column(ARRAY(Text))
    is_active: Mapped[bool] = mapped_column(server_default=text("true"))


class ShippingRate(HasId, Base):
    __tablename__ = "shipping_rates"

    zone_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("shipping_zones.id", ondelete="CASCADE"))
    name: Mapped[str]  # 'Standard (3-5 days)'
    description: Mapped[str | None]
    price_amount: Mapped[int] = mapped_column(MinorUnits)
    currency: Mapped[str] = mapped_column(CHAR(3), server_default="USD")
    min_subtotal_amount: Mapped[int | None] = mapped_column(MinorUnits)  # free over a threshold
    max_subtotal_amount: Mapped[int | None] = mapped_column(MinorUnits)
    min_weight_grams: Mapped[int | None]
    max_weight_grams: Mapped[int | None]
    est_days_min: Mapped[int | None]
    est_days_max: Mapped[int | None]
    is_active: Mapped[bool] = mapped_column(server_default=text("true"))
    position: Mapped[int] = mapped_column(server_default=text("0"))

    __table_args__ = (
        CheckConstraint("price_amount >= 0", name="price_amount_non_negative"),
        Index("idx_rates_zone", "zone_id", postgresql_where=text("is_active")),
    )


class TaxRate(HasId, Base):
    __tablename__ = "tax_rates"

    name: Mapped[str]  # 'VAT', 'Sales Tax'
    country_code: Mapped[str] = mapped_column(CHAR(2))
    region: Mapped[str | None]
    postal_prefix: Mapped[str | None]
    rate: Mapped[Decimal] = mapped_column(Numeric(6, 4))  # 0.0750 = 7.5%
    is_inclusive: Mapped[bool] = mapped_column(server_default=text("false"))  # EU-style
    priority: Mapped[int] = mapped_column(server_default=text("0"))
    is_active: Mapped[bool] = mapped_column(server_default=text("true"))

    __table_args__ = (
        CheckConstraint("rate >= 0 AND rate <= 1", name="rate_range"),
        Index("idx_tax_lookup", "country_code", "region", postgresql_where=text("is_active")),
    )
