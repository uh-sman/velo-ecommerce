"""Address book service.

Rules: at most one default shipping and one default billing address per user
(the database enforces it with partial unique indexes; this service keeps
requests from tripping them), a first address becomes the default, and the
default cannot be deleted while other addresses could take its place
(PAGE-SPECS.md §2.5).
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from velo.core.errors import NotFoundError
from velo.domains.identity.exceptions import AddressLimitError, DefaultAddressError
from velo.domains.identity.repository import AddressRecord, AddressRepository

MAX_ADDRESSES = 50
_DEFAULTS = ("is_default_shipping", "is_default_billing")


class AddressService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._addresses = AddressRepository(session)

    async def list(self, user_id: uuid.UUID) -> list[AddressRecord]:
        return await self._addresses.list(user_id)

    async def create(self, user_id: uuid.UUID, fields: dict[str, Any]) -> AddressRecord:
        existing = await self._addresses.count(user_id)
        if existing >= MAX_ADDRESSES:
            raise AddressLimitError(f"Delete an address first; the limit is {MAX_ADDRESSES}.")
        if existing == 0:
            # The first address is the default for both, or checkout has nothing to prefill.
            fields = {**fields, "is_default_shipping": True, "is_default_billing": True}
        await self._take_defaults(user_id, fields)
        address = await self._addresses.create(user_id, **fields)
        await self._session.commit()
        return address

    async def update(
        self, user_id: uuid.UUID, address_id: uuid.UUID, changes: dict[str, Any]
    ) -> AddressRecord:
        current = await self._get(user_id, address_id)
        for column in _DEFAULTS:
            # A default is moved by setting it elsewhere, never by unsetting it.
            if changes.get(column) is False and getattr(current, column):
                raise DefaultAddressError("Set another address as the default instead.")
        await self._take_defaults(user_id, changes)
        address = (
            await self._addresses.update(user_id, address_id, **changes) if changes else current
        )
        await self._session.commit()
        return address

    async def delete(self, user_id: uuid.UUID, address_id: uuid.UUID) -> None:
        address = await self._get(user_id, address_id)
        is_default = address.is_default_shipping or address.is_default_billing
        if is_default and await self._addresses.count(user_id) > 1:
            raise DefaultAddressError(
                "This is your default address. Choose another default before deleting it."
            )
        await self._addresses.delete(user_id, address_id)
        await self._session.commit()

    async def _get(self, user_id: uuid.UUID, address_id: uuid.UUID) -> AddressRecord:
        address = await self._addresses.get(user_id, address_id)
        if address is None:
            raise NotFoundError("No such address.")
        return address

    async def _take_defaults(self, user_id: uuid.UUID, fields: dict[str, Any]) -> None:
        for column in _DEFAULTS:
            if fields.get(column):
                await self._addresses.clear_default(user_id, column)
