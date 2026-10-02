"""PCI-DSS SAQ-A, rule 1 (PAYMENTS-AND-CHECKOUT.md §9): no endpoint accepts card data.

Walks every request body in the OpenAPI document — every schema a client can
send, nested ones included — and fails on any field whose name could hold a
card number, security code, or expiry. Card entry happens in the provider's
iframe; our API never has a field for it.
"""

from __future__ import annotations

import re
from typing import Any

from fastapi import FastAPI

_CARD_FIELD = re.compile(
    r"(^|_)(pan|card_?number|cc_?num(ber)?|cvc|cvv|cvv2|csc|security_code|exp(iry|iration)?"
    r"(_month|_year|_date)?|track_?data|magstripe)($|_)",
    re.IGNORECASE,
)


def _schema_names(schema: dict[str, Any], components: dict[str, Any], seen: set[str]) -> set[str]:
    names: set[str] = set()
    ref = schema.get("$ref")
    if isinstance(ref, str):
        name = ref.rsplit("/", 1)[-1]
        if name in seen:
            return names
        seen.add(name)
        return _schema_names(components[name], components, seen)
    for key, value in (schema.get("properties") or {}).items():
        names.add(key)
        names |= _schema_names(value, components, seen)
    for combinator in ("allOf", "anyOf", "oneOf"):
        for part in schema.get(combinator, []):
            names |= _schema_names(part, components, seen)
    if isinstance(schema.get("items"), dict):
        names |= _schema_names(schema["items"], components, seen)
    return names


def test_no_request_body_has_a_field_that_could_hold_card_data(app: FastAPI) -> None:
    document = app.openapi()
    components = document.get("components", {}).get("schemas", {})
    offenders: list[str] = []
    bodies = 0
    for path, operations in document["paths"].items():
        for method, operation in operations.items():
            for media in (operation.get("requestBody") or {}).get("content", {}).values():
                bodies += 1
                for name in _schema_names(media.get("schema", {}), components, set()):
                    if _CARD_FIELD.search(name):
                        offenders.append(f"{method.upper()} {path}: {name}")

    assert bodies > 20  # the walk really found the API's request bodies
    assert offenders == []


def test_the_pattern_catches_what_it_must() -> None:
    for name in ("card_number", "cardNumber", "pan", "cvc", "cvv", "expiry_month", "exp_year"):
        assert _CARD_FIELD.search(name), name
    for name in ("company", "expires_at", "panel", "shipping_rate_id", "postal_code", "expand"):
        assert not _CARD_FIELD.search(name), name
