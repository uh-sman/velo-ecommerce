"""Checkout's pure rules: order numbers, address normalisation, session tokens."""

from __future__ import annotations

import uuid

from velo.domains.checkout.service import checkout_token, normalise_address
from velo.domains.orders.service import ORDER_NUMBER_ALPHABET, new_order_number


def test_order_numbers_are_short_readable_and_random() -> None:
    numbers = {new_order_number() for _ in range(2000)}

    assert len(numbers) == 2000
    for number in numbers:
        assert number.startswith("VLO-") and len(number) == 10
        assert set(number[4:]) <= set(ORDER_NUMBER_ALPHABET)


def test_the_order_number_alphabet_has_no_look_alikes() -> None:
    assert not set("01ILOU") & set(ORDER_NUMBER_ALPHABET)
    assert len(ORDER_NUMBER_ALPHABET) == len(set(ORDER_NUMBER_ALPHABET)) == 30


def test_addresses_are_normalised_before_they_are_priced_or_stored() -> None:
    clean = normalise_address(
        {
            "first_name": "  Ada ",
            "last_name": "Lovelace",
            "line1": "1   Market  St",
            "line2": "   ",
            "city": "San Francisco",
            "region": "ca",
            "postal_code": "sw1a 1aa",
            "country_code": "us",
        }
    )

    assert clean["first_name"] == "Ada"
    assert clean["line1"] == "1 Market St"
    assert clean["line2"] is None
    assert clean["region"] == "CA"
    assert clean["postal_code"] == "SW1A 1AA"
    assert clean["country_code"] == "US"
    assert clean["company"] is None and clean["phone"] is None


def test_a_region_written_out_in_full_keeps_its_case() -> None:
    assert normalise_address({"country_code": "gb", "region": "Greater London"})["region"] == (
        "Greater London"
    )


def test_checkout_tokens_are_bound_to_the_session_and_the_secret() -> None:
    first, second = uuid.uuid4(), uuid.uuid4()

    assert checkout_token("s", first) == checkout_token("s", first)
    assert checkout_token("s", first) != checkout_token("s", second)
    assert checkout_token("s", first) != checkout_token("t", first)
    assert len(checkout_token("s", first)) == 43  # 256 bits, base64url
