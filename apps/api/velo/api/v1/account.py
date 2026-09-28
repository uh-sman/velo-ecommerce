"""/account — the signed-in customer's address book (API-SPEC.md §2)."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, status

from velo.api.deps import AddressServiceDep, PrincipalDep
from velo.domains.identity.schemas import AddressFields, AddressResponse, AddressUpdateRequest

router = APIRouter(prefix="/account", tags=["account"])


@router.get("/addresses", response_model=list[AddressResponse], summary="List addresses")
async def list_addresses(
    principal: PrincipalDep, service: AddressServiceDep
) -> list[AddressResponse]:
    return [AddressResponse.of(address) for address in await service.list(principal.user_id)]


@router.post(
    "/addresses",
    response_model=AddressResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Add an address",
)
async def create_address(
    body: AddressFields, principal: PrincipalDep, service: AddressServiceDep
) -> AddressResponse:
    address = await service.create(principal.user_id, body.model_dump())
    return AddressResponse.of(address)


@router.patch(
    "/addresses/{address_id}", response_model=AddressResponse, summary="Update an address"
)
async def update_address(
    address_id: uuid.UUID,
    body: AddressUpdateRequest,
    principal: PrincipalDep,
    service: AddressServiceDep,
) -> AddressResponse:
    changes = body.model_dump(exclude_unset=True)
    # Required columns cannot be cleared; an explicit null for them is ignored.
    for required in ("first_name", "last_name", "line1", "city", "country_code"):
        if changes.get(required, "") is None:
            changes.pop(required)
    for flag in ("is_default_shipping", "is_default_billing"):
        if changes.get(flag, False) is None:
            changes.pop(flag)
    address = await service.update(principal.user_id, address_id, changes)
    return AddressResponse.of(address)


@router.delete(
    "/addresses/{address_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete an address"
)
async def delete_address(
    address_id: uuid.UUID, principal: PrincipalDep, service: AddressServiceDep
) -> None:
    await service.delete(principal.user_id, address_id)
