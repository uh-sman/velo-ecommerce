"""Rendering an email: a kind, a context, and out come a subject, HTML and plain text.

Every kind is declared once in :data:`KINDS` — its subject, whether it is
transactional or marketing, and the sample context the development preview
and the tests render it with. Templates live beside this module (ADR-011):
``<kind>.html`` extends the shared layout, ``<kind>.txt`` is its plain-text
twin, and both get the same context.

Marketing kinds (abandoned-cart reminders) carry an unsubscribe link and a
``List-Unsubscribe`` header, and are skipped for anyone who opted out.
Transactional kinds — receipts, shipping, password resets — are always sent:
the customer needs them to complete what they started.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from jinja2 import Environment, FileSystemLoader, StrictUndefined, select_autoescape

TEMPLATES = Path(__file__).parent / "templates"

Category = Literal["transactional", "marketing", "internal"]


@dataclass(frozen=True, slots=True)
class Kind:
    subject: str  # a Jinja expression over the same context
    category: Category
    sample: dict[str, Any]


_LINES = [
    {"quantity": 2, "title": "Merino Crew Neck", "variant": "M / Navy", "amount": "USD 178.00"},
    {"quantity": 1, "title": "Canvas Tote", "variant": "", "amount": "USD 39.00"},
]
_ORDER_URL = "http://localhost:3000/orders/VLO-7K3M9Q?token=sample"

KINDS: dict[str, Kind] = {
    "order_confirmed": Kind(
        "Order {{ order_number }} confirmed",
        "transactional",
        {
            "order_number": "VLO-7K3M9Q",
            "lines": _LINES,
            "total": "USD 233.95",
            "order_url": _ORDER_URL,
        },
    ),
    "order_shipped": Kind(
        "Order {{ order_number }} is on its way",
        "transactional",
        {
            "order_number": "VLO-7K3M9Q",
            "lines": [{**line, "amount": None} for line in _LINES],
            "carrier": "UPS",
            "tracking_number": "1Z999AA10123456784",
            "tracking_url": "https://www.ups.com/track?tracknum=1Z999AA10123456784",
            "complete": True,
            "order_url": _ORDER_URL,
        },
    ),
    "order_delivered": Kind(
        "Order {{ order_number }} has arrived",
        "transactional",
        {"order_number": "VLO-7K3M9Q", "order_url": _ORDER_URL, "return_window_days": 30},
    ),
    "order_cancelled": Kind(
        "Order {{ order_number }} is cancelled",
        "transactional",
        {"order_number": "VLO-7K3M9Q", "by_customer": True},
    ),
    "refund_issued": Kind(
        "Refund for order {{ order_number }}",
        "transactional",
        {"order_number": "VLO-7K3M9Q", "amount": "USD 89.00"},
    ),
    "payment_failed": Kind(
        "Your payment did not go through",
        "transactional",
        {"cart_url": "http://localhost:3000/cart"},
    ),
    "verify_email": Kind(
        "Confirm your email address",
        "transactional",
        {"verify_url": "http://localhost:3000/verify-email?token=sample"},
    ),
    "password_reset": Kind(
        "Reset your {{ store.name }} password",
        "transactional",
        {"reset_url": "http://localhost:3000/reset-password?token=sample"},
    ),
    "welcome": Kind(
        "Welcome to {{ store.name }}",
        "transactional",
        {"first_name": "Ada", "shop_url": "http://localhost:3000/products"},
    ),
    "back_in_stock": Kind(
        "Back in stock: {{ product_title }}",
        "transactional",
        {
            "product_title": "Merino Crew Neck",
            "variant_title": "M / Navy",
            "product_url": "http://localhost:3000/products/merino-crew-neck",
        },
    ),
    "cart_recovery": Kind(
        "{% if step == 3 %}Last call: your cart"
        "{% else %}You left something in your cart{% endif %}",
        "marketing",
        {
            "step": 1,
            "first_name": "Ada",
            "lines": [{**line, "amount": None} for line in _LINES],
            "cart_url": "http://localhost:3000/cart/recover?token=sample",
        },
    ),
    "return_update": Kind(
        "{% if status == 'approved' %}Return {{ rma_number }} approved — how to send it back"
        "{% elif status == 'requested' %}We have your return request {{ rma_number }}"
        "{% else %}About your return request {{ rma_number }}{% endif %}",
        "transactional",
        {
            "status": "approved",
            "rma_number": "RMA-4FQ8ZT",
            "order_number": "VLO-7K3M9Q",
            "order_url": _ORDER_URL,
            "note": None,
        },
    ),
    "staff_invite": Kind(
        "You are invited to the {{ store.name }} admin",
        "internal",
        {
            "inviter": "Grace",
            "role": "staff",
            "invite_url": "http://localhost:3001/accept-invite?token=sample",
        },
    ),
}


@dataclass(frozen=True, slots=True)
class Rendered:
    subject: str
    html: str
    text: str
    category: Category


_html = Environment(
    loader=FileSystemLoader(TEMPLATES),
    autoescape=select_autoescape(["html"]),
    undefined=StrictUndefined,
    trim_blocks=True,
    lstrip_blocks=True,
)
_text = Environment(
    loader=FileSystemLoader(TEMPLATES),
    autoescape=False,  # noqa: S701 — plain text: nothing is interpreted as markup
    undefined=StrictUndefined,
    trim_blocks=True,
    lstrip_blocks=True,
    keep_trailing_newline=True,
)


def render(
    kind: str,
    context: dict[str, Any],
    *,
    store: dict[str, Any],
    texts: dict[str, Any],
    unsubscribe_url: str | None = None,
    preheader: str | None = None,
) -> Rendered:
    """Render ``kind``. Missing context is an error (StrictUndefined), never a blank."""
    spec = KINDS[kind]
    full = {
        **context,
        "store": store,
        "texts": texts,
        "unsubscribe_url": unsubscribe_url,
    }
    subject = _text.from_string(spec.subject).render(full).strip()
    full["subject"] = subject
    full["preheader"] = preheader or subject
    return Rendered(
        subject=subject,
        html=_html.get_template(f"{kind}.html").render(full),
        text=_text.get_template(f"{kind}.txt").render(full).strip() + "\n",
        category=spec.category,
    )
