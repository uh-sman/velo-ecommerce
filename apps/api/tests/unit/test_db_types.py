"""The MinorUnits guard: a float cannot reach a money column."""

from __future__ import annotations

from decimal import Decimal

import pytest
from sqlalchemy.dialects import postgresql

from velo.db.types import MinorUnits

DIALECT = postgresql.dialect()  # type: ignore[no-untyped-call]


def test_integers_and_null_pass_through() -> None:
    column_type = MinorUnits()

    assert column_type.process_bind_param(2999, DIALECT) == 2999
    assert column_type.process_bind_param(None, DIALECT) is None


@pytest.mark.parametrize("value", [29.99, Decimal("29.99"), "2999", True])
def test_anything_but_an_int_is_refused(value: object) -> None:
    with pytest.raises(TypeError, match="minor units"):
        MinorUnits().process_bind_param(value, DIALECT)


def test_the_database_type_is_bigint() -> None:
    assert str(MinorUnits().compile(dialect=DIALECT)) == "BIGINT"
