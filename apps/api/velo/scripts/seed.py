"""Demo data for development: a store you can click around in.

    uv run python -m velo.scripts.seed            # into an empty database
    uv run python -m velo.scripts.seed --reset    # empty the tables first

What it loads: 50 products with variants, option matrices, images, and stock;
categories; 3 collections; 5 discounts; shipping and tax rates; an admin; and a
demo customer with an order history that is internally consistent — every
order balances, every paid order has a captured payment, and each variant's
movement ledger sums to its stock on hand (DATA-MODEL.md §13, invariant 12).

Deterministic: the same run produces the same catalog, so screenshots and bug
reports stay comparable. Refuses to run in production.
"""

from __future__ import annotations

import argparse
import asyncio
import random
import sys
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from velo.core.config import get_settings
from velo.db.models import Base
from velo.db.session import dispose_engine, init_engine, session_scope
from velo.domains.cart.models import Cart
from velo.domains.catalog.models import (
    Category,
    Collection,
    OptionValue,
    Product,
    ProductCollection,
    ProductMedia,
    ProductOption,
    ProductVariant,
    Review,
    VariantOptionValue,
)
from velo.domains.checkout.models import CheckoutSession
from velo.domains.discounts.models import Discount
from velo.domains.identity.models import Address, User
from velo.domains.identity.passwords import hash_password
from velo.domains.inventory.models import InventoryItem, InventoryMovement
from velo.domains.orders.models import (
    Fulfilment,
    FulfilmentItem,
    Order,
    OrderEvent,
    OrderItem,
)
from velo.domains.payments.models import Payment
from velo.domains.shipping.models import ShippingRate, ShippingZone, TaxRate

ADMIN_EMAIL = "admin@velo.dev"
CUSTOMER_EMAIL = "customer@velo.dev"
DEMO_PASSWORD = "ChangeMe123!"  # noqa: S105 — documented in the README; development only
CURRENCY = "USD"
PRODUCT_COUNT = 50
CA_TAX_RATE = Decimal("0.0725")

_ORDER_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"  # no 0/O, 1/I/L

# ── Catalog blueprint ─────────────────────────────────────────────────────────

CATEGORIES: list[tuple[str, str, str | None]] = [
    # (slug, name, parent slug)
    ("apparel", "Apparel", None),
    ("tops", "Tops", "apparel"),
    ("bottoms", "Bottoms", "apparel"),
    ("outerwear", "Outerwear", "apparel"),
    ("footwear", "Footwear", None),
    ("accessories", "Accessories", None),
    ("bags", "Bags", "accessories"),
    ("hats", "Hats", "accessories"),
]

COLOURS: dict[str, str] = {
    "Black": "#111111",
    "Navy": "#1F2A44",
    "Stone": "#C8BFB0",
    "Olive": "#5B6236",
    "White": "#F5F5F2",
    "Rust": "#A0472A",
}

APPAREL_SIZES = ["XS", "S", "M", "L", "XL"]
SHOE_SIZES = ["7", "8", "9", "10", "11", "12"]


@dataclass(frozen=True)
class ProductType:
    noun: str
    category: str
    price: int  # minor units
    sizes: list[str] | None
    material: str


PRODUCT_TYPES = [
    ProductType("Tee", "tops", 2800, APPAREL_SIZES, "100% organic cotton"),
    ProductType("Oxford Shirt", "tops", 6800, APPAREL_SIZES, "Cotton oxford"),
    ProductType("Merino Crew", "tops", 9800, APPAREL_SIZES, "Extra-fine merino wool"),
    ProductType("Hoodie", "tops", 7800, APPAREL_SIZES, "Brushed-back fleece"),
    ProductType("Chino", "bottoms", 7400, APPAREL_SIZES, "Stretch cotton twill"),
    ProductType("Trail Short", "bottoms", 5400, APPAREL_SIZES, "Recycled nylon"),
    ProductType("Field Jacket", "outerwear", 18800, APPAREL_SIZES, "Waxed cotton canvas"),
    ProductType("Rain Shell", "outerwear", 15800, APPAREL_SIZES, "3-layer waterproof nylon"),
    ProductType("Runner", "footwear", 12800, SHOE_SIZES, "Knit upper, EVA sole"),
    ProductType("Court Sneaker", "footwear", 11000, SHOE_SIZES, "Full-grain leather"),
    ProductType("Tote", "bags", 4800, None, "Heavyweight canvas"),
    ProductType("Daypack", "bags", 9800, None, "Ripstop nylon"),
    ProductType("Cap", "hats", 3200, None, "Washed cotton twill"),
    ProductType("Beanie", "hats", 2800, None, "Ribbed lambswool"),
]

ADJECTIVES = [
    "Everyday",
    "Coastal",
    "Harbour",
    "Summit",
    "Meridian",
    "Northline",
    "Canyon",
    "Driftwood",
    "Ember",
    "Granite",
    "Linden",
    "Tidal",
]

COLLECTIONS = [
    ("new-arrivals", "New Arrivals", "The latest additions to the range."),
    ("best-sellers", "Best Sellers", "What everyone keeps coming back for."),
    ("summer-essentials", "Summer Essentials", "Light layers for long days."),
]


# ── Helpers ───────────────────────────────────────────────────────────────────


def _slugify(value: str) -> str:
    return "-".join(value.lower().replace("/", " ").split())


def _tax(amount: int, rate: Decimal) -> int:
    """Tax on an amount of minor units, rounded half-up to a whole minor unit."""
    return int((Decimal(amount) * rate).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _order_number(rng: random.Random) -> str:
    return "VLO-" + "".join(rng.choice(_ORDER_ALPHABET) for _ in range(6))


@dataclass
class SeededVariant:
    variant: ProductVariant
    product: Product
    image_url: str
    inventory: InventoryItem


@dataclass
class SeedResult:
    counts: dict[str, int] = field(default_factory=dict)


# ── Seeders ───────────────────────────────────────────────────────────────────


async def _seed_users(session: AsyncSession) -> tuple[User, User, Address]:
    password_hash = hash_password(DEMO_PASSWORD)
    now = datetime.now(UTC)
    admin = User(
        email=ADMIN_EMAIL,
        password_hash=password_hash,
        first_name="Ada",
        last_name="Admin",
        role="owner",
        email_verified_at=now,
    )
    customer = User(
        email=CUSTOMER_EMAIL,
        password_hash=password_hash,
        first_name="Casey",
        last_name="Customer",
        role="customer",
        email_verified_at=now,
        marketing_opt_in=True,
    )
    session.add_all([admin, customer])
    await session.flush()

    address = Address(
        user_id=customer.id,
        label="Home",
        first_name="Casey",
        last_name="Customer",
        line1="1600 Folsom Street",
        line2="Apt 4",
        city="San Francisco",
        region="CA",
        postal_code="94103",
        country_code="US",
        phone="+14155550123",
        is_default_shipping=True,
        is_default_billing=True,
    )
    session.add(address)
    await session.flush()
    return admin, customer, address


async def _seed_categories(session: AsyncSession) -> dict[str, Category]:
    by_slug: dict[str, Category] = {}
    for position, (slug, name, parent_slug) in enumerate(CATEGORIES):
        parent = by_slug[parent_slug] if parent_slug else None
        path = f"{parent.path}.{slug}" if parent else slug
        category = Category(
            slug=slug,
            name=name,
            parent_id=parent.id if parent else None,
            path=path,
            position=position,
        )
        session.add(category)
        await session.flush()
        by_slug[slug] = category
    return by_slug


async def _seed_catalog(
    session: AsyncSession,
    rng: random.Random,
    categories: dict[str, Category],
    admin: User,
) -> tuple[list[Product], list[SeededVariant]]:
    products: list[Product] = []
    variants: list[SeededVariant] = []
    now = datetime.now(UTC)

    names: list[tuple[str, ProductType]] = [
        (f"{adjective} {product_type.noun}", product_type)
        for product_type in PRODUCT_TYPES
        for adjective in ADJECTIVES
    ]
    rng.shuffle(names)

    for index, (title, product_type) in enumerate(names[:PRODUCT_COUNT]):
        slug = _slugify(title)
        # Most of the catalog is live; a few drafts and one archived product
        # exercise the storefront's filtering.
        status = "draft" if index % 17 == 16 else "archived" if index == 49 else "active"
        product = Product(
            slug=slug,
            title=title,
            subtitle=f"{product_type.material}.",
            description=(
                f"The {title} is cut from {product_type.material.lower()} and built to be "
                "worn hard. Designed in-house, made in small runs, and backed by a "
                "lifetime repair promise."
            ),
            brand="Velo",
            status=status,
            category_id=categories[product_type.category].id,
            seo_title=f"{title} | Velo",
            seo_description=f"{title} in {product_type.material.lower()}. Free returns.",
            attributes={
                "material": product_type.material,
                "care": "Machine wash cold, line dry.",
                "origin": rng.choice(["Portugal", "Japan", "USA", "Vietnam"]),
            },
            published_at=(now - timedelta(days=index)) if status == "active" else None,
        )
        session.add(product)
        await session.flush()
        products.append(product)

        colours = rng.sample(list(COLOURS), k=3 if product_type.sizes else 2)
        colour_option = ProductOption(product_id=product.id, name="Colour", position=0)
        session.add(colour_option)
        await session.flush()
        colour_values = []
        for position, colour in enumerate(colours):
            value = OptionValue(
                option_id=colour_option.id,
                value=colour,
                swatch_hex=COLOURS[colour],
                position=position,
            )
            session.add(value)
            colour_values.append(value)

        size_values: list[OptionValue | None] = [None]
        if product_type.sizes:
            size_option = ProductOption(product_id=product.id, name="Size", position=1)
            session.add(size_option)
            await session.flush()
            size_values = []
            for position, size in enumerate(product_type.sizes):
                value = OptionValue(option_id=size_option.id, value=size, position=position)
                session.add(value)
                size_values.append(value)
        await session.flush()

        # Every fourth product is on sale: compare-at above the price.
        price = product_type.price + rng.choice([0, 0, 200, 500])
        compare_at = price + price // 4 if index % 4 == 0 else None

        image_urls: dict[str, str] = {}
        for position, colour_value in enumerate(colour_values):
            url = f"https://picsum.photos/seed/{slug}-{_slugify(colour_value.value)}/1200/1500"
            image_urls[colour_value.value] = url
            session.add(
                ProductMedia(
                    product_id=product.id,
                    url=url,
                    alt_text=f"{title} in {colour_value.value.lower()}",
                    width=1200,
                    height=1500,
                    position=position,
                )
            )

        variant_position = 0
        for colour_value in colour_values:
            for size_value in size_values:
                parts = [colour_value.value] + ([size_value.value] if size_value else [])
                sku = "-".join(
                    ["VLO", f"{index + 1:03d}", colour_value.value[:3].upper()]
                    + ([size_value.value] if size_value else [])
                )
                variant = ProductVariant(
                    product_id=product.id,
                    sku=sku,
                    title=" / ".join(parts),
                    price_amount=price,
                    price_currency=CURRENCY,
                    compare_at_amount=compare_at,
                    cost_amount=price * 2 // 5,
                    weight_grams=rng.randint(150, 1400),
                    position=variant_position,
                )
                variant_position += 1
                session.add(variant)
                await session.flush()
                session.add(
                    VariantOptionValue(variant_id=variant.id, option_value_id=colour_value.id)
                )
                if size_value:
                    session.add(
                        VariantOptionValue(variant_id=variant.id, option_value_id=size_value.id)
                    )

                # Roughly one in eight variants is sold out; some sit at or
                # below the reorder point, so the low-stock report has rows.
                on_hand = 0 if rng.random() < 0.125 else rng.randint(1, 60)
                inventory = InventoryItem(
                    variant_id=variant.id, quantity_on_hand=on_hand, reorder_point=5
                )
                session.add(inventory)
                if on_hand:
                    session.add(
                        InventoryMovement(
                            variant_id=variant.id,
                            quantity_delta=on_hand,
                            reason="initial",
                            reference_type="manual",
                            actor_id=admin.id,
                            note="Opening stock (seed)",
                        )
                    )
                variants.append(
                    SeededVariant(variant, product, image_urls[colour_value.value], inventory)
                )
        await session.flush()

    return products, variants


async def _seed_collections(
    session: AsyncSession, rng: random.Random, products: list[Product]
) -> None:
    live = [product for product in products if product.status == "active"]
    for slug, title, description in COLLECTIONS:
        collection = Collection(slug=slug, title=title, description=description)
        session.add(collection)
        await session.flush()
        members = live[:12] if slug == "new-arrivals" else rng.sample(live, k=12)
        for position, product in enumerate(members):
            session.add(
                ProductCollection(
                    product_id=product.id, collection_id=collection.id, position=position
                )
            )
    await session.flush()


async def _seed_commerce_rules(session: AsyncSession) -> ShippingRate:
    now = datetime.now(UTC)
    session.add_all(
        [
            Discount(
                code="WELCOME10",
                title="10% off your first order",
                type="percentage",
                value=Decimal("10"),
                first_order_only=True,
                max_per_customer=1,
            ),
            Discount(
                code="SAVE20",
                title="$20 off orders over $100",
                type="fixed_amount",
                value=Decimal("2000"),
                currency=CURRENCY,
                min_subtotal_amount=10_000,
                max_redemptions=500,
            ),
            Discount(
                code="FREESHIP",
                title="Free shipping over $50",
                type="free_shipping",
                value=Decimal("0"),
                min_subtotal_amount=5_000,
            ),
            Discount(
                code=None,  # automatic: applied without a code
                title="15% off orders over $150",
                type="percentage",
                value=Decimal("15"),
                min_subtotal_amount=15_000,
            ),
            Discount(
                code="FLASH30",
                title="Flash sale (ended)",
                type="percentage",
                value=Decimal("30"),
                starts_at=now - timedelta(days=60),
                ends_at=now - timedelta(days=30),
            ),
        ]
    )

    domestic = ShippingZone(name="United States", country_codes=["US"])
    international = ShippingZone(
        name="International", country_codes=["CA", "GB", "DE", "FR", "NG", "AU"]
    )
    session.add_all([domestic, international])
    await session.flush()

    standard = ShippingRate(
        zone_id=domestic.id,
        name="Standard (3-5 days)",
        price_amount=599,
        currency=CURRENCY,
        max_subtotal_amount=7_499,
        est_days_min=3,
        est_days_max=5,
        position=0,
    )
    session.add_all(
        [
            standard,
            ShippingRate(
                zone_id=domestic.id,
                name="Free standard (3-5 days)",
                description="On orders of $75 or more.",
                price_amount=0,
                currency=CURRENCY,
                min_subtotal_amount=7_500,
                est_days_min=3,
                est_days_max=5,
                position=1,
            ),
            ShippingRate(
                zone_id=domestic.id,
                name="Express (1-2 days)",
                price_amount=1_499,
                currency=CURRENCY,
                est_days_min=1,
                est_days_max=2,
                position=2,
            ),
            ShippingRate(
                zone_id=international.id,
                name="International (7-14 days)",
                price_amount=1_999,
                currency=CURRENCY,
                est_days_min=7,
                est_days_max=14,
                position=0,
            ),
            TaxRate(name="California sales tax", country_code="US", region="CA", rate=CA_TAX_RATE),
            TaxRate(
                name="New York sales tax", country_code="US", region="NY", rate=Decimal("0.04")
            ),
            TaxRate(name="VAT", country_code="GB", rate=Decimal("0.20"), is_inclusive=True),
        ]
    )
    await session.flush()
    return standard


async def _seed_order_history(
    session: AsyncSession,
    rng: random.Random,
    customer: User,
    address: Address,
    variants: list[SeededVariant],
    shipping_rate: ShippingRate,
) -> list[Order]:
    """Three past orders: delivered, in transit, and paid awaiting fulfilment."""
    snapshot: dict[str, Any] = {
        "first_name": address.first_name,
        "last_name": address.last_name,
        "line1": address.line1,
        "line2": address.line2,
        "city": address.city,
        "region": address.region,
        "postal_code": address.postal_code,
        "country_code": address.country_code,
        "phone": address.phone,
    }
    in_stock = [
        seeded
        for seeded in variants
        if seeded.product.status == "active" and seeded.inventory.quantity_on_hand >= 3
    ]
    now = datetime.now(UTC)
    plans = [("delivered", 40), ("in_transit", 6), ("paid", 1)]
    orders: list[Order] = []

    for stage, days_ago in plans:
        placed_at = now - timedelta(days=days_ago)
        lines = rng.sample(in_stock, k=rng.randint(1, 3))
        quantities = [rng.randint(1, 2) for _ in lines]

        subtotal = sum(
            seeded.variant.price_amount * quantity
            for seeded, quantity in zip(lines, quantities, strict=True)
        )
        shipping = 0 if subtotal >= 7_500 else shipping_rate.price_amount
        line_taxes = [
            _tax(seeded.variant.price_amount * quantity, CA_TAX_RATE)
            for seeded, quantity in zip(lines, quantities, strict=True)
        ]
        tax = sum(line_taxes)
        total = subtotal + shipping + tax

        cart = Cart(user_id=customer.id, status="converted", currency=CURRENCY)
        session.add(cart)
        await session.flush()
        checkout = CheckoutSession(
            cart_id=cart.id,
            user_id=customer.id,
            email=customer.email,
            status="confirmed",
            shipping_address_id=address.id,
            billing_address_id=address.id,
            shipping_rate_id=shipping_rate.id if shipping else None,
            currency=CURRENCY,
            subtotal_amount=subtotal,
            shipping_amount=shipping,
            tax_amount=tax,
            total_amount=total,
            expires_at=placed_at + timedelta(minutes=30),
        )
        session.add(checkout)
        await session.flush()

        fulfilled = stage in ("delivered", "in_transit")
        order = Order(
            order_number=_order_number(rng),
            user_id=customer.id,
            email=customer.email,
            checkout_session_id=checkout.id,
            status={"delivered": "delivered", "in_transit": "fulfilled", "paid": "paid"}[stage],
            payment_status="paid",
            fulfilment_status="fulfilled" if fulfilled else "unfulfilled",
            currency=CURRENCY,
            subtotal_amount=subtotal,
            shipping_amount=shipping,
            tax_amount=tax,
            total_amount=total,
            shipping_address=snapshot,
            billing_address=snapshot,
            placed_at=placed_at,
        )
        session.add(order)
        await session.flush()

        items: list[OrderItem] = []
        for seeded, quantity, line_tax in zip(lines, quantities, line_taxes, strict=True):
            line_subtotal = seeded.variant.price_amount * quantity
            item = OrderItem(
                order_id=order.id,
                variant_id=seeded.variant.id,
                product_title=seeded.product.title,
                variant_title=seeded.variant.title,
                sku=seeded.variant.sku,
                image_url=seeded.image_url,
                unit_price_amount=seeded.variant.price_amount,
                quantity=quantity,
                tax_rate=CA_TAX_RATE,
                tax_amount=line_tax,
                total_amount=line_subtotal + line_tax,
                quantity_fulfilled=quantity if fulfilled else 0,
            )
            session.add(item)
            items.append(item)

            # The sale leaves the ledger and the balance in step.
            seeded.inventory.quantity_on_hand -= quantity
            session.add(
                InventoryMovement(
                    variant_id=seeded.variant.id,
                    quantity_delta=-quantity,
                    reason="sale",
                    reference_type="order",
                    reference_id=order.id,
                )
            )
        await session.flush()

        intent = f"pi_seed_{uuid.UUID(int=rng.getrandbits(128)).hex[:24]}"
        session.add(
            Payment(
                order_id=order.id,
                checkout_session_id=checkout.id,
                provider="stripe",
                provider_intent_id=intent,
                provider_charge_id=intent.replace("pi_", "ch_"),
                status="succeeded",
                amount=total,
                currency=CURRENCY,
                amount_captured=total,
                payment_method_type="card",
                card_brand="visa",
                card_last4="4242",
            )
        )

        events = [("created", None, "pending", "system"), ("paid", "pending", "paid", "webhook")]
        if fulfilled:
            events.append(("fulfilled", "paid", "fulfilled", "staff"))
            fulfilment = Fulfilment(
                order_id=order.id,
                status="delivered" if stage == "delivered" else "in_transit",
                carrier="UPS",
                tracking_number=f"1Z{rng.randint(10**15, 10**16 - 1)}",
                shipped_at=placed_at + timedelta(days=1),
                delivered_at=placed_at + timedelta(days=4) if stage == "delivered" else None,
            )
            session.add(fulfilment)
            await session.flush()
            for item in items:
                session.add(
                    FulfilmentItem(
                        fulfilment_id=fulfilment.id, order_item_id=item.id, quantity=item.quantity
                    )
                )
        if stage == "delivered":
            events.append(("delivered", "fulfilled", "delivered", "system"))
        for event_type, from_status, to_status, actor_type in events:
            session.add(
                OrderEvent(
                    order_id=order.id,
                    event_type=event_type,
                    from_status=from_status,
                    to_status=to_status,
                    actor_type=actor_type,
                )
            )

        if stage == "delivered":
            # Verified-purchase reviews, with the product's denormalised rating kept in step.
            # One review per product per order, even if two variants of it were bought.
            reviewed = {seeded.product.id: seeded.product for seeded in lines}
            for product in reviewed.values():
                rating = rng.choice([4, 5, 5])
                session.add(
                    Review(
                        product_id=product.id,
                        user_id=customer.id,
                        order_id=order.id,
                        rating=rating,
                        title="Exactly as described",
                        body="Fits well and the fabric feels great. Would buy again.",
                        status="approved",
                    )
                )
                product.rating_average = Decimal(rating)
                product.rating_count = 1

        await session.flush()
        orders.append(order)

    return orders


# ── Entry points ──────────────────────────────────────────────────────────────


async def reset(session: AsyncSession) -> None:
    """Empty every application table. Development only; the schema stays."""
    tables = ", ".join(f'"{table.name}"' for table in Base.metadata.sorted_tables)
    await session.execute(text(f"TRUNCATE {tables} RESTART IDENTITY CASCADE"))


async def seed(session: AsyncSession, *, random_seed: int = 42) -> SeedResult:
    """Load the demo data inside the caller's transaction."""
    existing = await session.scalar(select(func.count()).select_from(User))
    if existing:
        raise RuntimeError("The database already has users. Run with --reset to empty it first.")

    rng = random.Random(random_seed)  # noqa: S311 — demo data, not security
    admin, customer, address = await _seed_users(session)
    categories = await _seed_categories(session)
    products, variants = await _seed_catalog(session, rng, categories, admin)
    await _seed_collections(session, rng, products)
    shipping_rate = await _seed_commerce_rules(session)
    orders = await _seed_order_history(session, rng, customer, address, variants, shipping_rate)

    return SeedResult(
        counts={
            "products": len(products),
            "variants": len(variants),
            "collections": len(COLLECTIONS),
            "discounts": 5,
            "orders": len(orders),
        }
    )


async def _main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Load Velo demo data.")
    parser.add_argument("--reset", action="store_true", help="empty every table first")
    args = parser.parse_args(argv)

    settings = get_settings()
    if settings.is_production:
        sys.stderr.write("Refusing to seed a production database.\n")
        return 2

    init_engine(settings)
    try:
        async with session_scope() as session:
            if args.reset:
                await reset(session)
            result = await seed(session)
    except RuntimeError as exc:
        sys.stderr.write(f"{exc}\n")
        return 1
    finally:
        await dispose_engine()

    summary = ", ".join(f"{count} {name}" for name, count in result.counts.items())
    sys.stdout.write(f"Seeded {summary}.\n")
    sys.stdout.write(f"Admin: {ADMIN_EMAIL} / {DEMO_PASSWORD}\n")
    sys.stdout.write(f"Customer: {CUSTOMER_EMAIL} / {DEMO_PASSWORD}\n")
    return 0


def main() -> None:
    raise SystemExit(asyncio.run(_main(sys.argv[1:])))


if __name__ == "__main__":
    main()
