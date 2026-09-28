"""The database refuses what must never happen (DATA-MODEL.md §13).

Each test attempts a violation against the real migrated schema and asserts
that Postgres rejects it by name, so a test cannot pass because some *other*
constraint happened to fire.
"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from typing import Any

import pytest
from sqlalchemy import Table, insert, text, update
from sqlalchemy.exc import IntegrityError, StatementError
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession

from velo.domains.cart.models import Cart
from velo.domains.catalog.models import Product, ProductVariant
from velo.domains.checkout.models import CheckoutSession
from velo.domains.identity.models import User
from velo.domains.inventory.models import InventoryItem
from velo.domains.orders.models import Order, OrderItem
from velo.domains.payments.models import Payment, PaymentEvent

pytestmark = pytest.mark.integration

ADDRESS = {"line1": "1 Main St", "city": "Springfield", "country_code": "US"}


async def _insert(connection: AsyncConnection, table: Table | Any, **values: Any) -> uuid.UUID:
    table = getattr(table, "__table__", table)
    result = await connection.execute(insert(table).values(**values).returning(table.c.id))
    row_id: uuid.UUID = result.scalar_one()
    return row_id


async def _violates(
    connection: AsyncConnection, constraint: str, action: Callable[[], Awaitable[Any]]
) -> None:
    """Run ``action`` in a savepoint and require that ``constraint`` rejects it."""
    with pytest.raises(IntegrityError, match=constraint):
        async with connection.begin_nested():
            await action()


# ── Fixtures ──────────────────────────────────────────────────────────────────


@pytest.fixture
async def user_id(connection: AsyncConnection) -> uuid.UUID:
    return await _insert(connection, User, email="shopper@example.com")


@pytest.fixture
async def variant_id(connection: AsyncConnection) -> uuid.UUID:
    product_id = await _insert(connection, Product, slug="tee", title="Tee")
    return await _insert(
        connection, ProductVariant, product_id=product_id, sku="TEE-M", title="M", price_amount=2800
    )


@pytest.fixture
async def checkout_id(connection: AsyncConnection, user_id: uuid.UUID) -> uuid.UUID:
    cart_id = await _insert(connection, Cart, user_id=user_id)
    return await _insert(
        connection, CheckoutSession, cart_id=cart_id, user_id=user_id, email="shopper@example.com"
    )


def _order(**overrides: Any) -> dict[str, Any]:
    values: dict[str, Any] = {
        "order_number": f"VLO-{uuid.uuid4().hex[:6].upper()}",
        "email": "shopper@example.com",
        "currency": "USD",
        "subtotal_amount": 10_000,
        "discount_amount": 1_000,
        "shipping_amount": 500,
        "tax_amount": 725,
        "total_amount": 10_225,
        "shipping_address": ADDRESS,
        "billing_address": ADDRESS,
    }
    values.update(overrides)
    return values


# ── Invariant 1: no overselling ───────────────────────────────────────────────


async def test_reserved_stock_cannot_exceed_stock_on_hand(
    connection: AsyncConnection, variant_id: uuid.UUID
) -> None:
    await _insert(connection, InventoryItem, variant_id=variant_id, quantity_on_hand=5)

    async def reserve(quantity: int) -> None:
        await connection.execute(
            update(InventoryItem)
            .where(InventoryItem.variant_id == variant_id)
            .values(quantity_reserved=quantity)
        )

    await reserve(5)  # every last unit: allowed
    await _violates(connection, "reserved_within_stock", lambda: reserve(6))


async def test_stock_cannot_go_negative(connection: AsyncConnection, variant_id: uuid.UUID) -> None:
    await _violates(
        connection,
        "quantity_on_hand_non_negative",
        lambda: _insert(connection, InventoryItem, variant_id=variant_id, quantity_on_hand=-1),
    )


# ── Invariants 2-6: money and quantities balance ─────────────────────────────


async def test_order_total_must_balance(connection: AsyncConnection) -> None:
    await _insert(connection, Order, **_order())  # 10000 - 1000 + 500 + 725

    await _violates(
        connection,
        "order_totals_balance",
        lambda: _insert(connection, Order, **_order(total_amount=10_224)),
    )


async def test_checkout_total_must_balance(
    connection: AsyncConnection, checkout_id: uuid.UUID
) -> None:
    async def price(**amounts: int) -> None:
        await connection.execute(
            update(CheckoutSession).where(CheckoutSession.id == checkout_id).values(**amounts)
        )

    await price(subtotal_amount=5_000, shipping_amount=599, total_amount=5_599)
    await _violates(connection, "totals_balance", lambda: price(total_amount=1))
    await _violates(
        connection,
        "discount_within_subtotal",
        lambda: price(subtotal_amount=100, discount_amount=200, total_amount=-100 + 599),
    )


async def test_refunds_cannot_exceed_the_order_total(connection: AsyncConnection) -> None:
    await _violates(
        connection,
        "refund_within_total",
        lambda: _insert(connection, Order, **_order(refunded_amount=10_226)),
    )


async def test_payment_capture_and_refund_bounds(
    connection: AsyncConnection, checkout_id: uuid.UUID
) -> None:
    def payment(**overrides: Any) -> Awaitable[uuid.UUID]:
        values: dict[str, Any] = {
            "checkout_session_id": checkout_id,
            "provider": "stripe",
            "provider_intent_id": f"pi_{uuid.uuid4().hex}",
            "amount": 5_000,
            "currency": "USD",
        }
        values.update(overrides)
        return _insert(connection, Payment, **values)

    await payment(amount_captured=5_000, amount_refunded=5_000)
    await _violates(connection, "capture_within_amount", lambda: payment(amount_captured=5_001))
    await _violates(
        connection,
        "refund_within_capture",
        lambda: payment(amount_captured=3_000, amount_refunded=3_001),
    )


async def test_order_item_quantities_nest(connection: AsyncConnection) -> None:
    order_id = await _insert(connection, Order, **_order())

    def item(**overrides: Any) -> Awaitable[uuid.UUID]:
        values: dict[str, Any] = {
            "order_id": order_id,
            "product_title": "Tee",
            "variant_title": "M",
            "sku": "TEE-M",
            "unit_price_amount": 2_800,
            "quantity": 2,
            "total_amount": 5_600,
        }
        values.update(overrides)
        return _insert(connection, OrderItem, **values)

    await item(quantity_fulfilled=2, quantity_returned=1)
    await _violates(connection, "fulfilled_within_ordered", lambda: item(quantity_fulfilled=3))
    await _violates(
        connection,
        "returned_within_fulfilled",
        lambda: item(quantity_fulfilled=1, quantity_returned=2),
    )


# ── Invariants 7-9: exactly once ──────────────────────────────────────────────


async def test_one_order_per_checkout_session(
    connection: AsyncConnection, checkout_id: uuid.UUID
) -> None:
    await _insert(connection, Order, **_order(checkout_session_id=checkout_id))

    await _violates(
        connection,
        "uq_orders_checkout_session_id",
        lambda: _insert(connection, Order, **_order(checkout_session_id=checkout_id)),
    )


async def test_one_payment_per_provider_intent(
    connection: AsyncConnection, checkout_id: uuid.UUID
) -> None:
    values = {
        "checkout_session_id": checkout_id,
        "provider": "stripe",
        "provider_intent_id": "pi_123",
        "amount": 5_000,
        "currency": "USD",
    }
    await _insert(connection, Payment, **values)

    await _violates(
        connection,
        "uq_payments_provider_provider_intent_id",
        lambda: _insert(connection, Payment, **values),
    )


async def test_a_webhook_event_is_stored_once(connection: AsyncConnection) -> None:
    values = {
        "provider": "stripe",
        "provider_event_id": "evt_123",
        "event_type": "payment_intent.succeeded",
        "payload": {},
        "signature_verified": True,
    }
    await _insert(connection, PaymentEvent, **values)

    await _violates(
        connection,
        "uq_payment_events_provider_provider_event_id",
        lambda: _insert(connection, PaymentEvent, **values),
    )


# ── Everything else the schema promises ───────────────────────────────────────


async def test_status_values_are_checked(connection: AsyncConnection) -> None:
    await _violates(
        connection,
        "ck_products_status_valid",
        lambda: _insert(connection, Product, slug="x", title="X", status="published"),
    )


async def test_email_is_unique_regardless_of_case(
    connection: AsyncConnection, user_id: uuid.UUID
) -> None:
    await _violates(
        connection,
        "uq_users_email",
        lambda: _insert(connection, User, email="SHOPPER@Example.com"),
    )


async def test_a_cart_needs_an_owner_and_a_user_has_one_active_cart(
    connection: AsyncConnection, user_id: uuid.UUID
) -> None:
    await _violates(connection, "cart_has_owner", lambda: _insert(connection, Cart))

    await _insert(connection, Cart, user_id=user_id)
    await _insert(connection, Cart, user_id=user_id, status="converted")  # history is fine
    await _violates(
        connection, "uq_active_user_cart", lambda: _insert(connection, Cart, user_id=user_id)
    )


async def test_compare_at_price_must_exceed_the_price(
    connection: AsyncConnection, variant_id: uuid.UUID
) -> None:
    async def set_compare_at(amount: int) -> None:
        await connection.execute(
            update(ProductVariant)
            .where(ProductVariant.id == variant_id)
            .values(compare_at_amount=amount)
        )

    await set_compare_at(3_500)
    await _violates(connection, "compare_at_gt_price", lambda: set_compare_at(2_800))


async def test_raw_inserts_get_a_uuidv7_key(connection: AsyncConnection) -> None:
    user_id = await connection.scalar(
        text("INSERT INTO users (email) VALUES ('raw@example.com') RETURNING id")
    )
    assert isinstance(user_id, uuid.UUID)
    assert user_id.version == 7


async def test_a_float_price_never_reaches_the_database(
    session: AsyncSession, variant_id: uuid.UUID
) -> None:
    product_id = await session.scalar(
        text("SELECT product_id FROM product_variants WHERE id = :id"), {"id": variant_id}
    )
    session.add(ProductVariant(product_id=product_id, sku="TEE-L", title="L", price_amount=29.99))

    with pytest.raises(StatementError, match="minor units"):
        await session.flush()
