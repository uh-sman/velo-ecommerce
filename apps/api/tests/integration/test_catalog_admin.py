"""Catalog administration: permissions, rules, audit (PLANNING.md Phase 6.1)."""

from __future__ import annotations

from collections.abc import Callable
from contextlib import AbstractAsyncContextManager

import pytest

from tests.integration.catalog_support import category, collection, problem, product, sql, variant
from tests.integration.conftest import Browser, sign_in_as

pytestmark = pytest.mark.integration

NewBrowser = Callable[[], AbstractAsyncContextManager[Browser]]


# ── Who may do what ───────────────────────────────────────────────────────────


async def test_the_admin_catalog_is_closed_to_the_public_and_customers(
    new_browser: NewBrowser,
) -> None:
    async with new_browser() as anonymous, new_browser() as customer:
        await sign_in_as(customer, "shopper@example.com")

        assert (await anonymous.get("/api/v1/admin/products")).status_code == 401
        assert (await customer.get("/api/v1/admin/products")).status_code == 403
        response = await customer.post("/api/v1/admin/products", json={"title": "Nope"})
        assert response.status_code == 403


async def test_fulfilment_staff_adjust_stock_but_cannot_edit_the_catalog(
    admin: Browser, new_browser: NewBrowser
) -> None:
    created = await product(admin, "Role Tee")
    variant_id = created["variants"][0]["id"]
    async with new_browser() as packer:
        await sign_in_as(packer, "packer@example.com", "fulfilment")

        edit = await packer.patch(f"/api/v1/admin/products/{created['id']}", json={"title": "X"})
        adjust = await packer.post(
            f"/api/v1/admin/inventory/{variant_id}/adjust",
            json={"delta": 5, "reason": "restock"},
        )
        read = await packer.get("/api/v1/admin/products")

    assert edit.status_code == 403
    assert adjust.status_code == 200
    assert read.status_code == 200


# ── Products ──────────────────────────────────────────────────────────────────


async def test_slugs_are_generated_and_kept_unique(admin: Browser) -> None:
    first = await product(admin, "Merino Crew — Navy")
    second = await product(admin, "Merino Crew — Navy")

    taken = await admin.post(
        "/api/v1/admin/products", json={"title": "Other", "slug": first["slug"]}
    )

    assert first["slug"] == "merino-crew-navy"
    assert second["slug"] == "merino-crew-navy-2"
    assert (taken.status_code, problem(taken)) == (409, "slug-taken")
    assert taken.json()["errors"][0]["field"] == "slug"


async def test_a_product_cannot_go_live_without_a_variant(admin: Browser) -> None:
    created = await admin.post(
        "/api/v1/admin/products", json={"title": "Empty", "status": "active"}
    )
    draft = await product(admin, "Draft First", status="draft", variants=[])
    publish = await admin.patch(f"/api/v1/admin/products/{draft['id']}", json={"status": "active"})

    assert (created.status_code, problem(created)) == (422, "not-publishable")
    assert (publish.status_code, problem(publish)) == (422, "not-publishable")


async def test_publishing_stamps_the_publication_date_once(admin: Browser) -> None:
    draft = await product(admin, "Later Tee", status="draft")
    assert draft["published_at"] is None

    live = (
        await admin.patch(f"/api/v1/admin/products/{draft['id']}", json={"status": "active"})
    ).json()
    await admin.patch(f"/api/v1/admin/products/{draft['id']}", json={"status": "archived"})
    again = (
        await admin.patch(f"/api/v1/admin/products/{draft['id']}", json={"status": "active"})
    ).json()

    assert live["published_at"] is not None
    assert again["published_at"] == live["published_at"]


async def test_money_must_be_integer_minor_units(admin: Browser) -> None:
    response = await admin.post(
        "/api/v1/admin/products",
        json={"title": "Float", "variants": [{"sku": "F-1", "price": 29.99}]},
    )

    assert response.status_code == 422
    assert response.json()["errors"][0]["field"].endswith("price")


async def test_variant_rules_are_enforced(admin: Browser) -> None:
    created = await product(
        admin, "Rules Tee", variants=[variant(sku="R-M", options={"Size": "M"})]
    )
    path = f"/api/v1/admin/products/{created['id']}/variants"

    same_sku = await admin.post(path, json=variant(sku="R-M", options={"Size": "L"}))
    same_options = await admin.post(path, json=variant(options={"Size": "M"}))
    bad_compare = await admin.post(
        path, json=variant(price=3000, compare_at=3000, options={"Size": "S"})
    )
    added = await admin.post(path, json=variant(sku="R-L", options={"Size": "L"}))

    assert (same_sku.status_code, problem(same_sku)) == (409, "sku-taken")
    assert (same_options.status_code, problem(same_options)) == (409, "duplicate-variant")
    assert (bad_compare.status_code, problem(bad_compare)) == (422, "catalog-rule")
    assert added.status_code == 201
    size = next(option for option in added.json()["options"] if option["name"] == "Size")
    assert [value["value"] for value in size["values"]] == ["M", "L"]


async def test_changing_a_variant_prunes_option_values_no_one_uses(admin: Browser) -> None:
    created = await product(
        admin,
        "Prune Tee",
        variants=[variant(options={"Size": "M"}), variant(options={"Size": "L"})],
    )
    large = next(v for v in created["variants"] if v["option_values"]["Size"] == "L")

    updated = await admin.patch(
        f"/api/v1/admin/variants/{large['id']}", json={"options": {"Size": "XL"}}
    )

    body = updated.json()
    assert updated.status_code == 200
    assert {v["title"] for v in body["variants"]} == {"M", "XL"}
    assert [value["value"] for value in body["options"][0]["values"]] == ["M", "XL"]


async def test_the_last_variant_of_a_live_product_cannot_be_deleted(admin: Browser) -> None:
    created = await product(admin, "Last Tee", variants=[variant(), variant(options={"Size": "L"})])
    first, second = created["variants"]

    ok = await admin.delete(f"/api/v1/admin/variants/{first['id']}")
    refused = await admin.delete(f"/api/v1/admin/variants/{second['id']}")

    assert ok.status_code == 200
    assert (refused.status_code, problem(refused)) == (422, "not-publishable")


async def test_unknown_categories_and_collections_are_refused(admin: Browser) -> None:
    no_category = await admin.post(
        "/api/v1/admin/products", json={"title": "Lost", "category": "nowhere"}
    )
    no_collection = await admin.post(
        "/api/v1/admin/products", json={"title": "Lost", "collections": ["nowhere"]}
    )

    assert (no_category.status_code, no_category.json()["errors"][0]["field"]) == (422, "category")
    assert (no_collection.status_code, no_collection.json()["errors"][0]["field"]) == (
        422,
        "collections",
    )


async def test_admin_listing_includes_drafts_and_finds_by_sku(admin: Browser) -> None:
    await product(admin, "Listed Draft", status="draft", variants=[variant(sku="FIND-ME-1")])
    await product(admin, "Listed Live")

    everything = (await admin.get("/api/v1/admin/products")).json()
    drafts = (await admin.get("/api/v1/admin/products", params={"status": "draft"})).json()
    by_sku = (await admin.get("/api/v1/admin/products", params={"q": "FIND-ME"})).json()

    assert everything["pagination"]["total_count"] == 2
    assert [row["slug"] for row in drafts["data"]] == ["listed-draft"]
    assert [row["slug"] for row in by_sku["data"]] == ["listed-draft"]


async def test_every_admin_change_is_audited_with_its_actor(admin: Browser) -> None:
    created = await product(admin, "Audit Tee")
    await admin.patch(f"/api/v1/admin/products/{created['id']}", json={"title": "Audited Tee"})
    await admin.delete(f"/api/v1/admin/products/{created['id']}")

    actions = await sql(
        "SELECT string_agg(action, ',' ORDER BY created_at) FROM audit_log "
        "WHERE entity_id = CAST(:id AS uuid) AND actor_email = 'admin@example.com'",
        id=created["id"],
    )
    change = await sql(
        "SELECT changes->'title'->>'to' FROM audit_log WHERE action = 'product.updated'"
    )

    assert actions == "product.created,product.updated,product.deleted"
    assert change == "Audited Tee"


async def test_catalog_writes_are_announced_on_the_outbox(admin: Browser) -> None:
    created = await product(admin, "Outbox Tee")

    events = await sql(
        "SELECT count(*) FROM outbox_events WHERE aggregate_id = CAST(:id AS uuid) "
        "AND event_type = 'product.created'",
        id=created["id"],
    )

    assert events == 1


# ── Categories and collections ────────────────────────────────────────────────


async def test_moving_a_category_moves_its_subtree(admin: Browser, browser: Browser) -> None:
    await category(admin, "Apparel")
    await category(admin, "Sale")
    tops = await category(admin, "Tops", parent="apparel")
    await category(admin, "Tees", parent="tops")

    moved = await admin.patch(f"/api/v1/admin/categories/{tops['id']}", json={"parent": "sale"})
    paths = {c["slug"]: c["path"] for c in (await admin.get("/api/v1/admin/categories")).json()}

    assert moved.status_code == 200
    assert paths["tops"] == "sale.tops"
    assert paths["tees"] == "sale.tops.tees"


async def test_a_category_cannot_move_inside_itself(admin: Browser) -> None:
    apparel = await category(admin, "Apparel")
    await category(admin, "Tops", parent="apparel")

    response = await admin.patch(
        f"/api/v1/admin/categories/{apparel['id']}", json={"parent": "tops"}
    )

    assert (response.status_code, problem(response)) == (422, "catalog-rule")


async def test_renaming_a_category_slug_rewrites_descendant_paths(admin: Browser) -> None:
    apparel = await category(admin, "Apparel")
    await category(admin, "Tops", parent="apparel")

    await admin.patch(f"/api/v1/admin/categories/{apparel['id']}", json={"slug": "clothing"})
    paths = {c["slug"]: c["path"] for c in (await admin.get("/api/v1/admin/categories")).json()}

    assert paths == {"clothing": "clothing", "tops": "clothing.tops"}


async def test_a_category_with_children_cannot_be_deleted(admin: Browser, browser: Browser) -> None:
    apparel = await category(admin, "Apparel")
    tops = await category(admin, "Tops", parent="apparel")
    await product(admin, "Orphan Tee", category="tops")

    refused = await admin.delete(f"/api/v1/admin/categories/{apparel['id']}")
    deleted = await admin.delete(f"/api/v1/admin/categories/{tops['id']}")

    assert (refused.status_code, problem(refused)) == (422, "catalog-rule")
    assert deleted.status_code == 204
    # The product survives, uncategorised.
    assert (await browser.get("/api/v1/products/orphan-tee")).json()["category"] is None


async def test_collection_membership_is_replaced_and_checked(admin: Browser) -> None:
    one = await product(admin, "Member One")
    two = await product(admin, "Member Two")
    created = await collection(admin, "Edit", [one["id"]])

    replaced = await admin.patch(
        f"/api/v1/admin/collections/{created['id']}", json={"products": [two["id"], one["id"]]}
    )
    unknown = await admin.patch(
        f"/api/v1/admin/collections/{created['id']}",
        json={"products": ["00000000-0000-7000-8000-000000000000"]},
    )

    assert replaced.json()["products"] == [two["id"], one["id"]]
    assert (unknown.status_code, problem(unknown)) == (422, "catalog-rule")


# ── Reviews ───────────────────────────────────────────────────────────────────


async def test_reviews_are_moderated_before_they_count(
    admin: Browser, new_browser: NewBrowser
) -> None:
    await product(admin, "Reviewed Tee")
    path = "/api/v1/products/reviewed-tee/reviews"
    async with new_browser() as anonymous, new_browser() as customer, new_browser() as other:
        await sign_in_as(customer, "reviewer@example.com")
        await sign_in_as(other, "second@example.com")

        unauthenticated = await anonymous.post(path, json={"rating": 5})
        submitted = await customer.post(path, json={"rating": 4, "title": "Good", "body": "Fits."})
        twice = await customer.post(path, json={"rating": 5})
        await other.post(path, json={"rating": 2})
        before = (await anonymous.get(path)).json()["data"]
        not_allowed = await customer.patch(
            f"/api/v1/admin/reviews/{submitted.json()['id']}", json={"status": "approved"}
        )

        summary_before = (await anonymous.get(f"{path}/summary")).json()
        pending = (await admin.get("/api/v1/admin/reviews")).json()["data"]
        for review in pending:
            await admin.patch(f"/api/v1/admin/reviews/{review['id']}", json={"status": "approved"})
        after = (await anonymous.get(path)).json()["data"]
        rating = (await anonymous.get("/api/v1/products/reviewed-tee")).json()["rating"]
        summary = (await anonymous.get(f"{path}/summary")).json()

    assert unauthenticated.status_code == 401
    assert submitted.status_code == 201
    assert submitted.json()["verified_purchase"] is False
    assert (twice.status_code, problem(twice)) == (409, "already-reviewed")
    assert before == []
    assert not_allowed.status_code == 403
    assert len(pending) == 2
    assert len(after) == 2
    assert rating == {"average": 3.0, "count": 2}
    # Pending reviews are not in the distribution; approved ones are.
    assert summary_before["count"] == 0
    assert summary == {
        "average": 3.0,
        "count": 2,
        "distribution": {"1": 0, "2": 1, "3": 0, "4": 1, "5": 0},
    }


async def test_rejecting_a_review_recomputes_the_rating(
    admin: Browser, new_browser: NewBrowser
) -> None:
    await product(admin, "Rerated Tee")
    async with new_browser() as customer:
        await sign_in_as(customer, "rerate@example.com")
        review = (
            await customer.post("/api/v1/products/rerated-tee/reviews", json={"rating": 1})
        ).json()
    await admin.patch(f"/api/v1/admin/reviews/{review['id']}", json={"status": "approved"})

    await admin.patch(f"/api/v1/admin/reviews/{review['id']}", json={"status": "rejected"})

    detail = (await admin.get("/api/v1/products/rerated-tee")).json()
    assert detail["rating"] is None


async def place_order(email: str, variant_id: str, status: str) -> None:
    """A minimal order for ``email`` containing the variant — enough for the badge rule."""
    await sql(
        """
        WITH new_order AS (
            INSERT INTO orders (order_number, user_id, email, currency, status,
                                subtotal_amount, total_amount, shipping_address, billing_address)
            SELECT 'VLO-' || substr(md5(random()::text), 1, 8), id, email, 'USD', :status,
                   2800, 2800, '{}'::jsonb, '{}'::jsonb
            FROM users WHERE email = :email
            RETURNING id
        )
        INSERT INTO order_items (order_id, variant_id, product_title, variant_title, sku,
                                 unit_price_amount, quantity, total_amount)
        SELECT new_order.id, CAST(:variant AS uuid), 'Tee', 'M', 'SKU', 2800, 1, 2800
        FROM new_order
        """,
        email=email,
        variant=variant_id,
        status=status,
    )


async def test_a_paid_order_earns_the_verified_purchase_badge(
    admin: Browser, new_browser: NewBrowser
) -> None:
    bought = await product(admin, "Bought Tee")
    pending = await product(admin, "Pending Tee")
    async with new_browser() as customer:
        await sign_in_as(customer, "buyer@example.com")
        await place_order("buyer@example.com", bought["variants"][0]["id"], "delivered")
        await place_order("buyer@example.com", pending["variants"][0]["id"], "pending")

        verified = await customer.post("/api/v1/products/bought-tee/reviews", json={"rating": 5})
        unpaid = await customer.post("/api/v1/products/pending-tee/reviews", json={"rating": 5})

    assert verified.json()["verified_purchase"] is True
    assert unpaid.json()["verified_purchase"] is False  # an unpaid order is not a purchase
