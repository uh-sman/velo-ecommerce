"""Hooks shared by ``migrations/env.py`` and the schema tests.

They live in the package rather than in env.py so the test comparing models to
migrations uses exactly the rules ``alembic check`` uses.
"""

from __future__ import annotations

from typing import Any, Literal

from velo.db.types import Ltree, MinorUnits

# Expression indexes that Postgres stores in a normalised form Alembic cannot
# match against the model's text, so every comparison would report a spurious
# drop-and-recreate. Each is asserted directly in tests/integration/test_schema.py.
EXPRESSION_INDEXES = frozenset({"idx_products_fts"})


def include_object(
    obj: Any, name: str | None, type_: str, reflected: bool, compare_to: Any
) -> bool:
    return not (type_ == "index" and name in EXPRESSION_INDEXES)


def render_item(type_: str, obj: Any, autogen_context: Any) -> str | Literal[False]:
    """Keep migrations independent of application code where it is cheap to.

    A money column is a plain BIGINT in the database; the ``MinorUnits`` guard
    belongs to the ORM, so a migration renders the column type it creates.
    """
    if type_ == "type" and isinstance(obj, MinorUnits):
        return "sa.BigInteger()"
    if type_ == "type" and isinstance(obj, Ltree):
        autogen_context.imports.add("from velo.db.types import Ltree")
        return "Ltree()"
    return False
