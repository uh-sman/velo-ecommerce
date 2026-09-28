"""The seed script loads, and what it loads is internally consistent.

Run inside a rolled-back transaction: the test database is left as migrated.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from velo.domains.identity.passwords import verify_password
from velo.scripts.seed import ADMIN_EMAIL, DEMO_PASSWORD, seed

pytestmark = pytest.mark.integration


async def _count(session: AsyncSession, sql: str) -> int:
    return int(await session.scalar(text(sql)) or 0)


async def test_seed_loads_the_documented_data_set(session: AsyncSession) -> None:
    result = await seed(session)

    # PLANNING.md Phase 4: 50 products with variants and images, 3 collections,
    # 5 discounts, an admin, and a demo customer with an order history.
    assert await _count(session, "SELECT count(*) FROM products") == 50
    assert await _count(session, "SELECT count(*) FROM collections") == 3
    assert await _count(session, "SELECT count(*) FROM discounts") == 5
    assert result.counts["variants"] == await _count(
        session, "SELECT count(*) FROM product_variants"
    )
    assert (
        await _count(
            session,
            "SELECT count(*) FROM products p WHERE NOT EXISTS "
            "(SELECT 1 FROM product_media m WHERE m.product_id = p.id)",
        )
        == 0
    )
    assert (
        await _count(
            session,
            "SELECT count(*) FROM orders o JOIN users u ON u.id = o.user_id "
            "WHERE u.email = 'customer@velo.dev'",
        )
        == 3
    )

    admin = (
        await session.execute(
            text("SELECT role, password_hash FROM users WHERE email = :email"),
            {"email": ADMIN_EMAIL},
        )
    ).one()
    assert admin.role in {"admin", "owner"}
    assert verify_password(admin.password_hash, DEMO_PASSWORD)


async def test_seeded_data_satisfies_the_scheduled_invariants(session: AsyncSession) -> None:
    """DATA-MODEL.md §13 invariants 10-12, which no constraint can express."""
    await seed(session)

    # 10. Every order has at least one item.
    assert (
        await _count(
            session,
            "SELECT count(*) FROM orders o WHERE NOT EXISTS "
            "(SELECT 1 FROM order_items i WHERE i.order_id = o.id)",
        )
        == 0
    )
    # 11. Every paid order has a succeeded payment covering it.
    assert (
        await _count(
            session,
            "SELECT count(*) FROM orders o WHERE o.payment_status = 'paid' AND NOT EXISTS "
            "(SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'succeeded' "
            "AND p.amount_captured = o.total_amount)",
        )
        == 0
    )
    # 12. Each variant's movement ledger sums to its stock on hand.
    assert (
        await _count(
            session,
            "SELECT count(*) FROM inventory_items i LEFT JOIN "
            "(SELECT variant_id, sum(quantity_delta) AS total FROM inventory_movements "
            "GROUP BY variant_id) m USING (variant_id) "
            "WHERE coalesce(m.total, 0) <> i.quantity_on_hand",
        )
        == 0
    )


async def test_seed_refuses_a_database_that_already_has_users(session: AsyncSession) -> None:
    await seed(session)

    with pytest.raises(RuntimeError, match="--reset"):
        await seed(session)
