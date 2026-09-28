"""The address book: CRUD, defaults, and ownership."""

from __future__ import annotations

from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from typing import Any

import pytest

from tests.integration.conftest import Browser

pytestmark = pytest.mark.integration

NewBrowser = Callable[[], AbstractAsyncContextManager[Browser]]
BASE = "/api/v1/account/addresses"


def address(**overrides: Any) -> dict[str, Any]:
    values: dict[str, Any] = {
        "first_name": "Casey",
        "last_name": "Customer",
        "line1": "1600 Folsom Street",
        "city": "San Francisco",
        "region": "CA",
        "postal_code": "94103",
        "country_code": "US",
    }
    values.update(overrides)
    return values


@pytest.fixture
async def signed_in(browser: Browser) -> Browser:
    response = await browser.post(
        "/api/v1/auth/register",
        json={"email": "casey@example.com", "password": "tangerine-ocelot-harbour"},
    )
    assert response.status_code == 201
    return browser


async def test_addresses_require_authentication(browser: Browser) -> None:
    assert (await browser.get(BASE)).status_code == 401


async def test_the_first_address_becomes_the_default(signed_in: Browser) -> None:
    response = await signed_in.post(BASE, json=address())

    assert response.status_code == 201
    assert response.json()["is_default_shipping"] is True
    assert response.json()["is_default_billing"] is True


async def test_setting_a_new_default_moves_it(signed_in: Browser) -> None:
    first = (await signed_in.post(BASE, json=address())).json()
    second = (await signed_in.post(BASE, json=address(label="Work"))).json()
    assert second["is_default_shipping"] is False

    moved = await signed_in.patch(f"{BASE}/{second['id']}", json={"is_default_shipping": True})

    assert moved.status_code == 200
    listed = {item["id"]: item for item in (await signed_in.get(BASE)).json()}
    assert listed[second["id"]]["is_default_shipping"] is True
    assert listed[first["id"]]["is_default_shipping"] is False
    assert listed[first["id"]]["is_default_billing"] is True  # the other default is untouched


async def test_a_default_cannot_be_unset_directly(signed_in: Browser) -> None:
    first = (await signed_in.post(BASE, json=address())).json()

    response = await signed_in.patch(f"{BASE}/{first['id']}", json={"is_default_shipping": False})

    assert response.status_code == 409


async def test_the_default_cannot_be_deleted_while_others_exist(signed_in: Browser) -> None:
    first = (await signed_in.post(BASE, json=address())).json()
    second = (await signed_in.post(BASE, json=address(label="Work"))).json()

    blocked = await signed_in.delete(f"{BASE}/{first['id']}")
    assert blocked.status_code == 409

    assert (await signed_in.delete(f"{BASE}/{second['id']}")).status_code == 204
    assert (await signed_in.delete(f"{BASE}/{first['id']}")).status_code == 204  # now the only one
    assert (await signed_in.get(BASE)).json() == []


async def test_updates_change_only_what_is_sent(signed_in: Browser) -> None:
    created = (await signed_in.post(BASE, json=address())).json()

    response = await signed_in.patch(f"{BASE}/{created['id']}", json={"line2": "Apt 4"})

    assert response.json()["line2"] == "Apt 4"
    assert response.json()["line1"] == "1600 Folsom Street"


@pytest.mark.parametrize(
    "bad",
    [{"country_code": "usa"}, {"line1": ""}, {"surprise": "field"}],
)
async def test_invalid_addresses_are_rejected(signed_in: Browser, bad: dict[str, Any]) -> None:
    assert (await signed_in.post(BASE, json=address(**bad))).status_code == 422


async def test_another_users_address_is_not_found(
    signed_in: Browser, new_browser: NewBrowser
) -> None:
    mine = (await signed_in.post(BASE, json=address())).json()

    async with new_browser() as other:
        await other.post(
            "/api/v1/auth/register",
            json={"email": "other@example.com", "password": "tangerine-ocelot-harbour"},
        )
        read = await other.patch(f"{BASE}/{mine['id']}", json={"line2": "mine now"})
        delete = await other.delete(f"{BASE}/{mine['id']}")

    assert read.status_code == delete.status_code == 404
