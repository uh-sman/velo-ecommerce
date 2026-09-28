"""Column types the schema needs beyond SQLAlchemy's built-ins."""

from __future__ import annotations

from typing import Any

from sqlalchemy import BigInteger
from sqlalchemy.dialects.postgresql.base import ischema_names
from sqlalchemy.engine import Dialect
from sqlalchemy.types import TypeDecorator, UserDefinedType


class MinorUnits(TypeDecorator[int]):
    """A money amount: ``BIGINT`` minor units (ADR-005).

    The column is an ordinary ``BIGINT``; the decorator is the guard. Binding a
    float or a ``Decimal`` raises instead of being coerced, so ``29.99`` cannot
    reach a money column by any path through the ORM — including a query
    parameter.
    """

    impl = BigInteger
    cache_ok = True

    def process_bind_param(self, value: Any, dialect: Dialect) -> int | None:
        if value is None:
            return None
        if not isinstance(value, int) or isinstance(value, bool):
            raise TypeError(
                f"Money columns take int minor units, got {type(value).__name__} {value!r}. "
                "No floats, ever (DATA-MODEL.md §1)."
            )
        return value

    def process_result_value(self, value: Any, dialect: Dialect) -> int | None:
        return value if value is None else int(value)


class Ltree(UserDefinedType[str]):
    """Postgres ``ltree`` — a materialised category path such as ``apparel.tops``."""

    cache_ok = True

    def get_col_spec(self, **_kw: Any) -> str:
        return "LTREE"


# Teach reflection the type, so Alembic's model/database comparison sees an
# Ltree on both sides instead of warning about an unknown column type.
ischema_names["ltree"] = Ltree
