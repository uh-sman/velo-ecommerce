"""/admin/settings, /admin/shipping-zones, /admin/tax-rates — the store's configuration.

All need ``settings:manage`` (owners). Payment providers are shown — configured
or not, test or live — and never editable here: keys are secrets and stay in
the environment.
"""

from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Annotated, Any, Literal

from fastapi import APIRouter, status
from pydantic import BaseModel, ConfigDict, EmailStr, Field, StrictInt, StringConstraints

from velo.api.deps import SettingsManagerDep, SettingsServiceDep, ShippingAdminDep
from velo.domains.shipping.models import ShippingRate, ShippingZone, TaxRate

router = APIRouter(prefix="/admin", tags=["admin: settings"])

Text = Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
Country = Annotated[str, StringConstraints(strip_whitespace=True, pattern=r"^[A-Za-z]{2}$")]


class StoreSection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Name | None = None
    support_email: EmailStr | None = None
    phone: Annotated[str, StringConstraints(strip_whitespace=True, max_length=40)] | None = None
    address: Annotated[list[Text], Field(max_length=6)] | None = None


class EmailsSection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    order_confirmed_intro: Text | None = None
    order_shipped_intro: Text | None = None
    signature: Text | None = None


class ProviderView(BaseModel):
    name: str
    configured: bool
    webhook_configured: bool
    mode: Literal["test", "live"] | None
    default: bool
    currencies: list[str]


class SettingsView(BaseModel):
    store: dict[str, Any]
    emails: dict[str, Any]
    payment_providers: list[ProviderView]


@router.get("/settings", response_model=SettingsView, summary="Store settings and providers")
async def get_settings(_: SettingsManagerDep, service: SettingsServiceDep) -> SettingsView:
    values = await service.all()
    return SettingsView(
        store=values["store"],
        emails=values["emails"],
        payment_providers=[ProviderView(**p) for p in service.payment_providers()],
    )


@router.patch("/settings/store", response_model=dict[str, Any], summary="Store details")
async def update_store(
    body: StoreSection, actor: SettingsManagerDep, service: SettingsServiceDep
) -> dict[str, Any]:
    return await service.update("store", body.model_dump(exclude_none=True, mode="json"), actor)


@router.patch("/settings/emails", response_model=dict[str, Any], summary="Words in customer emails")
async def update_emails(
    body: EmailsSection, actor: SettingsManagerDep, service: SettingsServiceDep
) -> dict[str, Any]:
    return await service.update("emails", body.model_dump(exclude_none=True), actor)


# ── Shipping ──────────────────────────────────────────────────────────────────


class RateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Name
    description: Text | None = None
    price_amount: Annotated[StrictInt, Field(ge=0)]
    currency: Annotated[str, StringConstraints(pattern=r"^[A-Z]{3}$")] = "USD"
    min_subtotal_amount: Annotated[StrictInt, Field(ge=0)] | None = None
    max_subtotal_amount: Annotated[StrictInt, Field(ge=0)] | None = None
    min_weight_grams: Annotated[StrictInt, Field(ge=0)] | None = None
    max_weight_grams: Annotated[StrictInt, Field(ge=0)] | None = None
    est_days_min: Annotated[StrictInt, Field(ge=0)] | None = None
    est_days_max: Annotated[StrictInt, Field(ge=0)] | None = None
    is_active: bool = True
    position: StrictInt = 0


class RatePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Name | None = None
    description: Text | None = None
    price_amount: Annotated[StrictInt, Field(ge=0)] | None = None
    min_subtotal_amount: Annotated[StrictInt, Field(ge=0)] | None = None
    max_subtotal_amount: Annotated[StrictInt, Field(ge=0)] | None = None
    min_weight_grams: Annotated[StrictInt, Field(ge=0)] | None = None
    max_weight_grams: Annotated[StrictInt, Field(ge=0)] | None = None
    est_days_min: Annotated[StrictInt, Field(ge=0)] | None = None
    est_days_max: Annotated[StrictInt, Field(ge=0)] | None = None
    is_active: bool | None = None
    position: StrictInt | None = None


class RateView(BaseModel):
    id: uuid.UUID
    zone_id: uuid.UUID
    name: str
    description: str | None
    price_amount: int
    currency: str
    min_subtotal_amount: int | None
    max_subtotal_amount: int | None
    min_weight_grams: int | None
    max_weight_grams: int | None
    est_days_min: int | None
    est_days_max: int | None
    is_active: bool
    position: int

    @classmethod
    def of(cls, rate: ShippingRate) -> RateView:
        return cls.model_validate(rate, from_attributes=True)


class ZoneIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Name
    country_codes: Annotated[list[Country], Field(min_length=1, max_length=250)]
    regions: list[Name] | None = None
    is_active: bool = True


class ZonePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Name | None = None
    country_codes: Annotated[list[Country], Field(min_length=1, max_length=250)] | None = None
    regions: list[Name] | None = None
    is_active: bool | None = None


class ZoneView(BaseModel):
    id: uuid.UUID
    name: str
    country_codes: list[str]
    regions: list[str] | None
    is_active: bool
    rates: list[RateView]

    @classmethod
    def of(cls, zone: ShippingZone, rates: list[ShippingRate]) -> ZoneView:
        return cls(
            id=zone.id,
            name=zone.name,
            country_codes=list(zone.country_codes),
            regions=list(zone.regions) if zone.regions else None,
            is_active=zone.is_active,
            rates=[RateView.of(rate) for rate in rates],
        )


@router.get("/shipping-zones", response_model=list[ZoneView], summary="Zones and their rates")
async def list_zones(_: SettingsManagerDep, service: ShippingAdminDep) -> list[ZoneView]:
    return [ZoneView.of(zone, rates) for zone, rates in await service.zones()]


@router.post("/shipping-zones", response_model=ZoneView, status_code=status.HTTP_201_CREATED)
async def create_zone(
    body: ZoneIn, actor: SettingsManagerDep, service: ShippingAdminDep
) -> ZoneView:
    return ZoneView.of(await service.create_zone(body.model_dump(), actor), [])


@router.patch("/shipping-zones/{zone_id}", response_model=ZoneView)
async def update_zone(
    zone_id: uuid.UUID, body: ZonePatch, actor: SettingsManagerDep, service: ShippingAdminDep
) -> ZoneView:
    zone = await service.update_zone(zone_id, body.model_dump(exclude_unset=True), actor)
    rates = next((r for z, r in await service.zones() if z.id == zone.id), [])
    return ZoneView.of(zone, rates)


@router.post(
    "/shipping-zones/{zone_id}/rates", response_model=RateView, status_code=status.HTTP_201_CREATED
)
async def create_rate(
    zone_id: uuid.UUID, body: RateIn, actor: SettingsManagerDep, service: ShippingAdminDep
) -> RateView:
    return RateView.of(await service.create_rate(zone_id, body.model_dump(), actor))


@router.patch("/shipping-rates/{rate_id}", response_model=RateView)
async def update_rate(
    rate_id: uuid.UUID, body: RatePatch, actor: SettingsManagerDep, service: ShippingAdminDep
) -> RateView:
    return RateView.of(
        await service.update_rate(rate_id, body.model_dump(exclude_unset=True), actor)
    )


# ── Tax ───────────────────────────────────────────────────────────────────────


class TaxIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Name
    country_code: Country
    region: Annotated[str, StringConstraints(strip_whitespace=True, max_length=60)] | None = None
    postal_prefix: (
        Annotated[str, StringConstraints(strip_whitespace=True, max_length=20)] | None
    ) = None
    rate: Annotated[Decimal, Field(ge=0, le=1, max_digits=6, decimal_places=4)]
    is_inclusive: bool = False
    priority: StrictInt = 0
    is_active: bool = True


class TaxPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Name | None = None
    region: Annotated[str, StringConstraints(strip_whitespace=True, max_length=60)] | None = None
    postal_prefix: (
        Annotated[str, StringConstraints(strip_whitespace=True, max_length=20)] | None
    ) = None
    rate: Annotated[Decimal, Field(ge=0, le=1, max_digits=6, decimal_places=4)] | None = None
    is_inclusive: bool | None = None
    priority: StrictInt | None = None
    is_active: bool | None = None


class TaxView(BaseModel):
    id: uuid.UUID
    name: str
    country_code: str
    region: str | None
    postal_prefix: str | None
    rate: Decimal
    is_inclusive: bool
    priority: int
    is_active: bool

    @classmethod
    def of(cls, rate: TaxRate) -> TaxView:
        return cls.model_validate(rate, from_attributes=True)


@router.get("/tax-rates", response_model=list[TaxView], summary="Tax rates")
async def list_tax(_: SettingsManagerDep, service: ShippingAdminDep) -> list[TaxView]:
    return [TaxView.of(rate) for rate in await service.tax_rates()]


@router.post("/tax-rates", response_model=TaxView, status_code=status.HTTP_201_CREATED)
async def create_tax(body: TaxIn, actor: SettingsManagerDep, service: ShippingAdminDep) -> TaxView:
    return TaxView.of(await service.create_tax(body.model_dump(), actor))


@router.patch("/tax-rates/{tax_id}", response_model=TaxView)
async def update_tax(
    tax_id: uuid.UUID, body: TaxPatch, actor: SettingsManagerDep, service: ShippingAdminDep
) -> TaxView:
    return TaxView.of(await service.update_tax(tax_id, body.model_dump(exclude_unset=True), actor))
