"""Order arithmetic and small rules — pure functions, unit-tested on their own.

**Refunding part of a line.** A line's ``total_amount`` is what the customer
paid for it: price times quantity, less its share of discounts, plus its tax.
Refunding ``k`` of its ``n`` units refunds a proportional share — but floor
division alone would leave cents behind (3 units of 1000 at 1/3 each). So the
share is taken *cumulatively*: the units refunded so far, plus these, times
the total, over the quantity, minus what was already given. Refund every unit
one at a time or all at once, and the sum is exactly the line total.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import uuid
from collections.abc import Iterable

RMA_PREFIX = "RMA-"
_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"


def line_share(total: int, quantity: int, already: int, units: int) -> int:
    """What ``units`` more of a line are worth, after ``already`` were refunded."""
    if quantity <= 0 or units <= 0:
        return 0
    already = max(0, min(already, quantity))
    upto = min(quantity, already + units)
    return (total * upto) // quantity - (total * already) // quantity


def shipping_share(order_total: int, line_totals: Iterable[int]) -> int:
    """Shipping and its tax: what the order charged beyond its lines."""
    return max(0, order_total - sum(line_totals))


def refundable(captured: int, refunded_or_pending: int) -> int:
    """The capture ledger's ceiling (PAYMENTS-AND-CHECKOUT.md §8)."""
    return max(0, captured - refunded_or_pending)


def new_rma_number() -> str:
    return RMA_PREFIX + "".join(secrets.choice(_ALPHABET) for _ in range(6))


# ── Guest access ──────────────────────────────────────────────────────────────
#
# "Track this order works for guests via a signed link" (PAGE-SPECS.md §1.4).
# The token is an HMAC of the order id under the server secret, scoped by a
# purpose string so it cannot be replayed as any other kind of token. Nothing
# is stored; rotating the secret revokes every link.


def order_token(secret: str, order_id: uuid.UUID) -> str:
    digest = hmac.new(
        secret.encode(), f"order-access:{order_id}".encode(), hashlib.sha256
    ).hexdigest()
    return digest[:32]


def verify_order_token(secret: str, order_id: uuid.UUID, token: str | None) -> bool:
    if not token:
        return False
    return hmac.compare_digest(order_token(secret, order_id), token)
