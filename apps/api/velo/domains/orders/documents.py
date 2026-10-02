"""Order documents as PDF: the invoice, the packing slip, the return label.

Rendered on request from the order's snapshots — the invoice for an order
reads the same in five years as today, because nothing it prints comes from
the live catalog (DATA-MODEL.md §7, "Why order data is snapshotted").

The PDF core fonts cover Latin-1 only, so text is folded to it: typographic
punctuation to its plain equivalent, anything else to "?". Money is printed
with its currency code rather than a symbol (₦ and ₵ are not in Latin-1).
"""

from __future__ import annotations

import unicodedata
from collections.abc import Sequence
from datetime import datetime
from typing import Any

from fpdf import FPDF

from velo.domains.orders.repository import (
    FulfilmentRecord,
    OrderItemRecord,
    OrderRecord,
    ReturnRecord,
)

_ZERO_DECIMAL = {"JPY", "KRW", "VND", "CLP", "XAF", "XOF", "UGX", "RWF"}
# Typographic characters to their plain Latin-1 equivalents, by code point.
_FOLD = str.maketrans(
    {
        0x2014: "-",  # em dash
        0x2013: "-",  # en dash
        0x2018: "'",
        0x2019: "'",
        0x201C: '"',
        0x201D: '"',
        0x2026: "...",
        0x00A0: " ",  # no-break space
        0x2022: "-",  # bullet
    }
)


def text(value: Any) -> str:
    raw = "" if value is None else str(value)
    folded = unicodedata.normalize("NFKC", raw.translate(_FOLD))
    return folded.encode("latin-1", "replace").decode("latin-1")


def money(amount: int, currency: str) -> str:
    if currency.upper() in _ZERO_DECIMAL:
        return f"{currency} {amount:,}"
    sign = "-" if amount < 0 else ""
    return f"{sign}{currency} {abs(amount) / 100:,.2f}"


def _address_lines(address: dict[str, Any]) -> list[str]:
    name = " ".join(filter(None, [address.get("first_name"), address.get("last_name")]))
    locality = ", ".join(
        filter(None, [address.get("city"), address.get("region"), address.get("postal_code")])
    )
    return [
        line
        for line in (
            name,
            address.get("company"),
            address.get("line1"),
            address.get("line2"),
            locality,
            address.get("country_code"),
        )
        if line
    ]


class _Document(FPDF):
    def __init__(self, title: str, store: str) -> None:
        super().__init__(format="A4")
        self._title = title
        self._store = store
        self.set_auto_page_break(auto=True, margin=18)
        self.set_margins(18, 18, 18)
        self.add_page()

    def header(self) -> None:
        self.set_font("Helvetica", "B", 16)
        self.cell(0, 8, text(self._store), new_x="LMARGIN", new_y="NEXT")
        self.set_font("Helvetica", "", 11)
        self.set_text_color(90, 90, 90)
        self.cell(0, 6, text(self._title), new_x="LMARGIN", new_y="NEXT")
        self.set_text_color(0, 0, 0)
        self.ln(4)

    def footer(self) -> None:
        self.set_y(-12)
        self.set_font("Helvetica", "", 8)
        self.set_text_color(120, 120, 120)
        self.cell(0, 6, f"Page {self.page_no()}", align="C")

    def label_value(self, label: str, value: str) -> None:
        self.set_font("Helvetica", "B", 10)
        self.cell(40, 6, text(label))
        self.set_font("Helvetica", "", 10)
        self.cell(0, 6, text(value), new_x="LMARGIN", new_y="NEXT")

    def block(self, heading: str, lines: Sequence[str], *, x: float | None = None) -> float:
        if x is not None:
            self.set_x(x)
        start_x = self.get_x()
        self.set_font("Helvetica", "B", 10)
        self.cell(80, 6, text(heading), new_x="LEFT", new_y="NEXT")
        self.set_font("Helvetica", "", 10)
        for line in lines:
            self.set_x(start_x)
            self.cell(80, 5, text(line), new_x="LEFT", new_y="NEXT")
        return self.get_y()

    def grid(
        self,
        headings: Sequence[str],
        widths: Sequence[float],
        rows: Sequence[Sequence[str]],
        aligns: str,
    ) -> None:
        self.set_font("Helvetica", "B", 9)
        self.set_fill_color(240, 240, 240)
        for heading, width, align in zip(headings, widths, aligns, strict=True):
            self.cell(width, 7, text(heading), border="B", align=align, fill=True)
        self.ln()
        self.set_font("Helvetica", "", 9)
        for row in rows:
            for value, width, align in zip(row, widths, aligns, strict=True):
                self.cell(width, 6, text(value)[:70], border="B", align=align)
            self.ln()

    def output_bytes(self) -> bytes:
        return bytes(self.output())


def _title(item: OrderItemRecord) -> str:
    return (
        f"{item.product_title} - {item.variant_title}" if item.variant_title else item.product_title
    )


def _date(value: datetime | None) -> str:
    return value.strftime("%d %b %Y") if value else ""


def invoice_pdf(
    order: OrderRecord,
    items: Sequence[OrderItemRecord],
    *,
    store_name: str,
    payment_label: str | None,
) -> bytes:
    doc = _Document(f"Invoice {order.order_number}", store_name)
    doc.label_value("Invoice number", order.order_number)
    doc.label_value("Invoice date", _date(order.placed_at))
    doc.label_value("Customer", order.email)
    if payment_label:
        doc.label_value("Paid with", payment_label)
    doc.ln(3)
    top = doc.get_y()
    left_end = doc.block(
        "Billed to", _address_lines(order.billing_address or order.shipping_address)
    )
    doc.set_y(top)
    right_end = doc.block("Shipped to", _address_lines(order.shipping_address), x=110)
    doc.set_y(max(left_end, right_end) + 4)

    currency = order.currency
    doc.grid(
        ["Item", "SKU", "Qty", "Unit", "Tax", "Total"],
        [66, 30, 12, 24, 18, 24],
        [
            [
                f"{item.product_title} - {item.variant_title}"
                if item.variant_title
                else item.product_title,
                item.sku,
                str(item.quantity),
                money(item.unit_price_amount, currency),
                f"{float(item.tax_rate) * 100:.2f}%",
                money(item.total_amount, currency),
            ]
            for item in items
        ],
        "LLRRRR",
    )
    doc.ln(3)
    totals = [
        ("Subtotal", order.subtotal_amount),
        (
            "Discount" + (f" ({order.discount_code})" if order.discount_code else ""),
            -order.discount_amount,
        ),
        ("Shipping", order.shipping_amount),
        ("Tax", order.tax_amount),
        ("Total", order.total_amount),
    ]
    if order.refunded_amount:
        totals.append(("Refunded", -order.refunded_amount))
    for label, amount in totals:
        if label.startswith("Discount") and amount == 0:
            continue
        bold = label in ("Total",)
        doc.set_font("Helvetica", "B" if bold else "", 10)
        doc.cell(150, 6, text(label), align="R")
        doc.cell(24, 6, money(amount, currency), align="R", new_x="LMARGIN", new_y="NEXT")
    doc.ln(6)
    doc.set_font("Helvetica", "", 8)
    doc.set_text_color(90, 90, 90)
    doc.multi_cell(
        0,
        4,
        text(
            "Prices, titles and tax rates are as they were when the order was placed. "
            "Keep this invoice for your records."
        ),
    )
    return doc.output_bytes()


def packing_slip_pdf(
    order: OrderRecord,
    items: Sequence[OrderItemRecord],
    *,
    store_name: str,
    fulfilment: FulfilmentRecord | None = None,
) -> bytes:
    """What goes in the box: lines and quantities, no prices."""
    doc = _Document(f"Packing slip {order.order_number}", store_name)
    doc.label_value("Order", order.order_number)
    doc.label_value("Placed", _date(order.placed_at))
    if fulfilment and fulfilment.tracking_number:
        doc.label_value(
            "Tracking", f"{fulfilment.carrier or ''} {fulfilment.tracking_number}".strip()
        )
    doc.ln(2)
    doc.block("Ship to", _address_lines(order.shipping_address))
    doc.ln(4)
    in_parcel = dict(fulfilment.items) if fulfilment else None
    rows = []
    for item in items:
        quantity = (
            in_parcel.get(item.id, 0)
            if in_parcel is not None
            else item.quantity - item.quantity_fulfilled
        )
        if quantity <= 0:
            continue
        rows.append(
            ["[  ]", item.sku, f"{item.product_title} - {item.variant_title}", str(quantity)]
        )
    doc.grid(["Picked", "SKU", "Item", "Qty"], [18, 36, 104, 16], rows, "CLLR")
    if order.customer_note:
        doc.ln(4)
        doc.block("Customer note", [order.customer_note])
    return doc.output_bytes()


def return_label_pdf(
    order: OrderRecord,
    items: Sequence[OrderItemRecord],
    returned: ReturnRecord,
    *,
    store_name: str,
    return_address: Sequence[str],
) -> bytes:
    """Print, tape to the parcel. The RMA number is what the warehouse scans."""
    doc = _Document(f"Return {returned.rma_number}", store_name)
    doc.set_font("Helvetica", "B", 28)
    doc.cell(0, 16, text(returned.rma_number), align="C", new_x="LMARGIN", new_y="NEXT")
    doc.set_font("Helvetica", "", 10)
    doc.cell(0, 6, text(f"Order {order.order_number}"), align="C", new_x="LMARGIN", new_y="NEXT")
    doc.ln(6)
    top = doc.get_y()
    left_end = doc.block("From", _address_lines(order.shipping_address))
    doc.set_y(top)
    right_end = doc.block("Return to", list(return_address), x=110)
    doc.set_y(max(left_end, right_end) + 6)
    by_id = {item.id: item for item in items}
    doc.grid(
        ["SKU", "Item", "Qty"],
        [40, 118, 16],
        [
            [
                by_id[line.order_item_id].sku,
                _title(by_id[line.order_item_id]),
                str(line.quantity),
            ]
            for line in returned.items
            if line.order_item_id in by_id
        ],
        "LLR",
    )
    doc.ln(6)
    doc.set_font("Helvetica", "", 9)
    doc.multi_cell(
        0,
        5,
        text(
            "Pack the items securely, with this sheet inside the parcel and the RMA number "
            "written on the outside. We refund once the return arrives and is checked."
        ),
    )
    return doc.output_bytes()
