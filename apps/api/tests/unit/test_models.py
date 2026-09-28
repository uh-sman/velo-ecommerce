"""Schema conventions (DATA-MODEL.md §1), checked over every model at once.

These catch the mistakes a reviewer skims past: a money column that is not
BIGINT, a naive timestamp, an unnamed constraint, an unconstrained status.
"""

from __future__ import annotations

import pytest
from sqlalchemy import JSON, CheckConstraint, DateTime, Float, Numeric, Table
from sqlalchemy.dialects.postgresql import JSONB

from velo.db.models import Base
from velo.db.types import MinorUnits

TABLES = sorted(Base.metadata.tables.values(), key=lambda table: table.name)

# Every table in DATA-MODEL.md §3-§10.
EXPECTED_TABLES = {
    "users", "refresh_tokens", "addresses",
    "categories", "products", "product_variants", "product_options", "option_values",
    "variant_option_values", "collections", "product_collections", "product_media", "reviews",
    "inventory_items", "inventory_movements", "inventory_reservations",
    "carts", "cart_items",
    "checkout_sessions", "orders", "order_items", "order_events", "fulfilments",
    "fulfilment_items", "returns", "return_items",
    "payments", "payment_events", "refunds", "idempotency_keys",
    "discounts", "discount_redemptions", "shipping_zones", "shipping_rates", "tax_rates",
    "outbox_events", "webhook_deliveries", "audit_log",
}  # fmt: skip


# Status-named columns that are not state-machine states: an event's from/to
# spans every state machine, and a stored HTTP response status is a number.
NOT_A_STATE = {"from_status", "to_status", "response_status"}


def _is_money(column_name: str) -> bool:
    return column_name.endswith("_amount") or column_name in {
        "amount",
        "amount_captured",
        "amount_refunded",
    }


def test_every_documented_table_has_a_model() -> None:
    assert {table.name for table in TABLES} == EXPECTED_TABLES


@pytest.mark.parametrize("table", TABLES, ids=lambda table: table.name)
def test_money_columns_are_minor_units(table: Table) -> None:
    for column in table.columns:
        where = f"{table.name}.{column.name}"
        if _is_money(column.name):
            assert isinstance(column.type, MinorUnits), f"{where} is money but not MinorUnits"
        # No float anywhere in the schema, money or not. (Float subclasses
        # Numeric, so this also rules out NUMERIC money.)
        assert not isinstance(column.type, Float), f"{where} is a float"
        if isinstance(column.type, Numeric):
            assert not _is_money(column.name), f"{where} is NUMERIC money"


@pytest.mark.parametrize("table", TABLES, ids=lambda table: table.name)
def test_timestamps_are_timezone_aware(table: Table) -> None:
    for column in table.columns:
        if isinstance(column.type, DateTime):
            assert column.type.timezone, f"{table.name}.{column.name} is a naive timestamp"


@pytest.mark.parametrize("table", TABLES, ids=lambda table: table.name)
def test_check_constraints_are_named(table: Table) -> None:
    for constraint in table.constraints:
        if isinstance(constraint, CheckConstraint):
            assert constraint.name, f"unnamed CHECK on {table.name}: {constraint.sqltext}"


@pytest.mark.parametrize("table", TABLES, ids=lambda table: table.name)
def test_status_columns_are_constrained(table: Table) -> None:
    """TEXT + CHECK for every status (DATA-MODEL.md §1)."""
    checks = " ".join(
        str(constraint.sqltext)
        for constraint in table.constraints
        if isinstance(constraint, CheckConstraint)
    )
    for column in table.columns:
        if column.name in NOT_A_STATE:
            continue
        if column.name == "status" or column.name.endswith("_status"):
            assert f"{column.name} IN (" in checks, f"{table.name}.{column.name} is unconstrained"


@pytest.mark.parametrize("table", TABLES, ids=lambda table: table.name)
def test_json_columns_are_jsonb(table: Table) -> None:
    for column in table.columns:
        if isinstance(column.type, JSON):
            assert isinstance(column.type, JSONB), f"{table.name}.{column.name} is JSON, not JSONB"


def test_financial_records_are_never_soft_deleted() -> None:
    for name in ("orders", "order_items", "payments", "refunds", "payment_events"):
        assert "deleted_at" not in Base.metadata.tables[name].columns
