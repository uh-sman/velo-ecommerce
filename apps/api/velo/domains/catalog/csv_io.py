"""Bulk catalog import and export as CSV — one row per variant.

The export is the import format, so a round trip (export → edit in a
spreadsheet → import) is the intended workflow.

**Import is all or nothing.** Every row is validated and applied inside one
transaction. If any row fails — or the request is a dry run — the transaction
rolls back and the report lists what would have happened and every problem,
by row number and column. A half-imported catalog is harder to repair than a
rejected file.

Matching: a row's product is found by ``product_slug`` and its variant by
``sku``. Existing products and variants are updated from the non-empty cells;
new ones are created. Stock is set only when a variant is created — changes to
existing stock go through inventory adjustments, which require a reason.

Prices are decimal major units ("29.99"), parsed with ``Decimal`` — never
float — and stored as minor units (ADR-005).
"""

from __future__ import annotations

import csv
import io
import re
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from velo.core.jobs import JobQueue, NullJobQueue
from velo.domains.catalog.cache import CatalogCache
from velo.domains.catalog.repository import CatalogRepository, ProductRecord
from velo.domains.inventory.service import InventoryService
from velo.domains.platform.events import Actor, record_audit, record_event

MAX_ROWS = 10_000
MAX_OPTIONS = 3
EXPORT_BATCH = 200

COLUMNS = [
    "product_slug",
    "title",
    "subtitle",
    "brand",
    "status",
    "category",
    "collections",
    "description",
    "seo_title",
    "seo_description",
    "sku",
    "variant_title",
    "option1_name",
    "option1_value",
    "option2_name",
    "option2_value",
    "option3_name",
    "option3_value",
    "price",
    "compare_at",
    "cost",
    "currency",
    "weight_grams",
    "barcode",
    "stock",
    "reorder_point",
]
REQUIRED = ("product_slug", "sku", "price")
_SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_STATUSES = ("draft", "active", "archived")


class ImportProblem(BaseModel):
    row: int  # 1-based, counting the header as row 1 — as a spreadsheet shows it
    column: str | None
    message: str


class ImportReport(BaseModel):
    dry_run: bool
    applied: bool
    rows: int
    products_created: int = 0
    products_updated: int = 0
    variants_created: int = 0
    variants_updated: int = 0
    errors: list[ImportProblem] = []


class ImportRejectedError(Exception):
    """The file itself is unusable: wrong columns, too big, not CSV."""


@dataclass
class _Row:
    number: int
    cells: dict[str, str]
    options: dict[str, str] = field(default_factory=dict)
    price: int = 0
    compare_at: int | None = None
    cost: int | None = None
    weight_grams: int | None = None
    stock: int = 0
    reorder_point: int | None = None


def to_minor(value: str) -> int:
    """'29.99' → 2999. At most two decimal places; never through float."""
    amount = Decimal(value.strip().replace(",", ""))
    if amount < 0:
        raise ValueError("cannot be negative")
    if amount.as_tuple().exponent < -2:  # type: ignore[operator]
        raise ValueError("at most two decimal places")
    return int(amount * 100)


def from_minor(amount: int | None) -> str:
    return "" if amount is None else f"{Decimal(amount) / 100:.2f}"


class CatalogCsvService:
    def __init__(
        self,
        session: AsyncSession,
        *,
        cache: CatalogCache,
        inventory: InventoryService,
        jobs: JobQueue | None = None,
    ) -> None:
        self._session = session
        self._catalog = CatalogRepository(session)
        self._cache = cache
        self._inventory = inventory
        self._jobs = jobs or NullJobQueue()

    # ── Import ────────────────────────────────────────────────────────────

    def _parse(self, data: bytes) -> tuple[list[_Row], list[ImportProblem]]:
        try:
            text = data.decode("utf-8-sig")  # Excel writes a BOM
        except UnicodeDecodeError as exc:
            raise ImportRejectedError("The file must be UTF-8 encoded CSV.") from exc
        reader = csv.DictReader(io.StringIO(text))
        header = [name.strip() for name in reader.fieldnames or []]
        missing = [name for name in REQUIRED if name not in header]
        if missing:
            raise ImportRejectedError(f"Missing required columns: {', '.join(missing)}.")
        unknown = [name for name in header if name and name not in COLUMNS]
        if unknown:
            raise ImportRejectedError(f"Unknown columns: {', '.join(unknown)}.")

        rows: list[_Row] = []
        problems: list[ImportProblem] = []
        for index, raw in enumerate(reader, start=2):
            if index - 1 > MAX_ROWS:
                raise ImportRejectedError(f"At most {MAX_ROWS} rows per file.")
            cells = {key.strip(): (value or "").strip() for key, value in raw.items() if key}
            if not any(cells.values()):
                continue  # blank line
            row = _Row(number=index, cells=cells)
            problems.extend(self._validate(row))
            rows.append(row)
        if not rows:
            raise ImportRejectedError("The file has no rows.")
        return rows, problems

    def _validate(self, row: _Row) -> list[ImportProblem]:
        problems: list[ImportProblem] = []
        cells = row.cells

        def problem(column: str | None, message: str) -> None:
            problems.append(ImportProblem(row=row.number, column=column, message=message))

        for name in REQUIRED:
            if not cells.get(name):
                problem(name, "Required.")
        slug = cells.get("product_slug", "")
        if slug and not _SLUG.match(slug):
            problem("product_slug", "Lowercase letters, digits and single hyphens only.")
        status = cells.get("status", "")
        if status and status not in _STATUSES:
            problem("status", f"Must be one of: {', '.join(_STATUSES)}.")
        currency = cells.get("currency", "")
        if currency and not re.fullmatch(r"[A-Z]{3}", currency):
            problem("currency", "A three-letter ISO code, such as USD.")

        for column in ("price", "compare_at", "cost"):
            if cells.get(column):
                try:
                    setattr(row, column, to_minor(cells[column]))
                except InvalidOperation:
                    problem(column, "Not a number. Use a plain amount such as 29.99.")
                except ValueError as exc:
                    problem(column, f"Not a valid amount: {exc}.")
        if row.compare_at is not None and row.compare_at <= row.price:
            problem("compare_at", "Must be higher than the price.")
        for column in ("weight_grams", "stock", "reorder_point"):
            if cells.get(column):
                try:
                    value = int(cells[column])
                    if value < 0:
                        raise ValueError
                    setattr(row, column, value)
                except ValueError:
                    problem(column, "A whole number, zero or more.")
        for n in range(1, MAX_OPTIONS + 1):
            name, option_value = cells.get(f"option{n}_name", ""), cells.get(f"option{n}_value", "")
            if bool(name) != bool(option_value):
                problem(
                    f"option{n}_value" if name else f"option{n}_name",
                    "Give both a name and a value.",
                )
            elif name:
                if name in row.options:
                    problem(f"option{n}_name", f"Option “{name}” appears twice.")
                row.options[name] = option_value
        return problems

    async def import_csv(self, data: bytes, *, dry_run: bool, actor: Actor) -> ImportReport:
        rows, problems = self._parse(data)
        report = ImportReport(dry_run=dry_run, applied=False, rows=len(rows))

        skus: dict[str, int] = {}
        for row in rows:
            sku = row.cells.get("sku", "")
            if sku in skus:
                problems.append(
                    ImportProblem(
                        row=row.number, column="sku", message=f"Duplicate of row {skus[sku]}."
                    )
                )
            elif sku:
                skus[sku] = row.number

        groups: dict[str, list[_Row]] = {}
        for row in rows:
            groups.setdefault(row.cells.get("product_slug", ""), []).append(row)

        touched: list[tuple[uuid.UUID, str]] = []
        if not problems:
            for slug, group in groups.items():
                try:
                    async with self._session.begin_nested():
                        touched.append(await self._apply(slug, group, report, problems, actor))
                except _RowFailedError:
                    continue

        report.errors = problems
        if problems or dry_run:
            await self._session.rollback()
            return report

        record_audit(
            self._session,
            actor,
            "catalog.imported",
            "product",
            None,
            report.model_dump(exclude={"errors", "dry_run", "applied"}),
        )
        for product_id, slug in touched:
            record_event(self._session, "product", product_id, "product.updated", {"slug": slug})
        await self._session.commit()
        await self._cache.invalidate_product(*(slug for _, slug in touched))
        await self._cache.bump()
        await self._jobs.kick_outbox()
        report.applied = True
        return report

    async def _apply(
        self,
        slug: str,
        group: list[_Row],
        report: ImportReport,
        problems: list[ImportProblem],
        actor: Actor,
    ) -> tuple[uuid.UUID, str]:
        first = group[0]

        def fail(row: _Row, column: str | None, message: str) -> _RowFailedError:
            problems.append(ImportProblem(row=row.number, column=column, message=message))
            return _RowFailedError()

        fields: dict[str, Any] = {}
        for column in (
            "title",
            "subtitle",
            "brand",
            "description",
            "seo_title",
            "seo_description",
            "status",
        ):
            value = next((row.cells.get(column) for row in group if row.cells.get(column)), None)
            if value:
                fields[column] = value
        category_slug = next((r.cells["category"] for r in group if r.cells.get("category")), None)
        if category_slug:
            category = await self._catalog.category(slug=category_slug)
            if category is None:
                raise fail(first, "category", f"No category “{category_slug}”.")
            fields["category_id"] = category.id
        collections_cell = next(
            (r.cells["collections"] for r in group if r.cells.get("collections")), None
        )
        collections = (
            [c.strip() for c in collections_cell.split("|") if c.strip()]
            if collections_cell
            else None
        )
        if collections:
            unknown = set(collections) - await self._catalog.collection_slugs_known(collections)
            if unknown:
                raise fail(first, "collections", f"No collection: {', '.join(sorted(unknown))}.")

        product: ProductRecord | None = await self._catalog.product_by_slug_any(slug)
        if product is None:
            if "title" not in fields:
                raise fail(first, "title", "Required for a new product.")
            status = fields.get("status", "draft")
            product = await self._catalog.create_product(
                slug=slug,
                attributes={},
                published_at=None,
                **{**fields, "status": "draft"},
            )
            report.products_created += 1
            publish = status == "active"
        else:
            publish = fields.get("status") == "active" and product.published_at is None
            if fields:
                product = await self._catalog.update_product(product.id, **fields)
            report.products_updated += 1

        position = len(await self._catalog.variants([product.id]))
        for row in group:
            sku = row.cells["sku"]
            existing = await self._catalog.variant_by_sku(sku)
            if existing is not None and existing.product_id != product.id:
                raise fail(row, "sku", f"SKU belongs to another product ({existing.product_id}).")
            option_ids = [
                await self._catalog.ensure_option_value(product.id, name, value)
                for name, value in row.options.items()
            ]
            columns: dict[str, Any] = {
                "price_amount": row.price,
                "compare_at_amount": row.compare_at,
                "cost_amount": row.cost,
                "weight_grams": row.weight_grams,
                "barcode": row.cells.get("barcode") or None,
                "title": row.cells.get("variant_title")
                or " / ".join(row.options.values())
                or "Default",
            }
            if row.cells.get("currency"):
                columns["price_currency"] = row.cells["currency"]
            if existing is None:
                if await self._catalog.variant_matrix_taken(product.id, option_ids, except_id=None):
                    raise fail(row, "option1_value", "Another variant already has these options.")
                variant_id = await self._catalog.create_variant(
                    product.id, option_ids, sku=sku, position=position, **columns
                )
                position += 1
                await self._inventory.open_stock(
                    variant_id,
                    quantity=row.stock,
                    reorder_point=row.reorder_point if row.reorder_point is not None else 5,
                    actor=actor,
                )
                report.variants_created += 1
            else:
                if row.options and await self._catalog.variant_matrix_taken(
                    product.id, option_ids, except_id=existing.id
                ):
                    raise fail(row, "option1_value", "Another variant already has these options.")
                await self._catalog.update_variant(existing.id, **columns)
                if row.options:
                    await self._catalog.replace_variant_options(existing.id, option_ids)
                report.variants_updated += 1

        if collections is not None:
            await self._catalog.set_product_collections(product.id, collections)
        await self._catalog.prune_unused_option_values(product.id)
        if publish:
            product = await self._catalog.update_product(
                product.id, status="active", published_at=product.published_at or datetime.now(UTC)
            )
        return product.id, product.slug

    # ── Export ────────────────────────────────────────────────────────────

    async def export_rows(self) -> AsyncIterator[str]:
        """The whole catalog, streamed in batches, header first."""
        yield self._line(COLUMNS)
        categories = {c.id: c.slug for c in await self._catalog.categories()}
        after: uuid.UUID | None = None
        while True:
            products = await self._catalog.all_products_for_export(limit=EXPORT_BATCH, after=after)
            if not products:
                return
            ids = [product.id for product in products]
            variants = await self._catalog.variants(ids)
            collections = await self._catalog.collection_slugs(ids)
            by_product: dict[uuid.UUID, list[Any]] = {}
            for variant in variants:
                by_product.setdefault(variant.product_id, []).append(variant)
            for product in products:
                for index, variant in enumerate(by_product.get(product.id, [])):
                    first = index == 0  # product columns once, on the first variant row
                    options = list(variant.option_values.items())[:MAX_OPTIONS]
                    option_cells: list[str] = []
                    for n in range(MAX_OPTIONS):
                        option_cells.extend(options[n] if n < len(options) else ("", ""))
                    yield self._line(
                        [
                            product.slug,
                            product.title if first else "",
                            (product.subtitle or "") if first else "",
                            (product.brand or "") if first else "",
                            product.status if first else "",
                            categories.get(product.category_id, "")
                            if first and product.category_id
                            else "",
                            "|".join(collections.get(product.id, [])) if first else "",
                            (product.description or "") if first else "",
                            (product.seo_title or "") if first else "",
                            (product.seo_description or "") if first else "",
                            variant.sku,
                            variant.title,
                            *option_cells,
                            from_minor(variant.price_amount),
                            from_minor(variant.compare_at_amount),
                            from_minor(variant.cost_amount),
                            variant.price_currency,
                            "" if variant.weight_grams is None else str(variant.weight_grams),
                            variant.barcode or "",
                            "",  # stock: set on create only; see the module docstring
                            "",
                        ]
                    )
            after = products[-1].id

    @staticmethod
    def _line(values: list[str]) -> str:
        buffer = io.StringIO()
        csv.writer(buffer, lineterminator="\n").writerow(values)
        return buffer.getvalue()


class _RowFailedError(Exception):
    """Raised inside a product's savepoint once its problem has been recorded."""
