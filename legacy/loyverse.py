import hmac
import hashlib
import json
from models import LoyverseOrder, ChargePayload


def verify_signature(payload: dict, signature: str, secret: str) -> bool:
    """Verify Loyverse HMAC-SHA256 signature. Uses JSON stable serialization."""
    if not signature:
        return False
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    expected = hmac.new(secret.encode("utf-8"), raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


def order_to_charge(order: LoyverseOrder) -> ChargePayload:
    """Map Loyverse order to a minimal ChargePayload for Cloudbeds."""
    # best-effort mapping: prefer reservation_id in meta, then room_number
    meta = order.meta or {}
    reservation_id = meta.get("reservation_id") or meta.get("reservation")
    room_number = meta.get("room_number")
    description = f"Loyverse order {order.id}"
    amount = float(order.total)
    return ChargePayload(
        reservation_id=reservation_id,
        room_number=room_number,
        amount=amount,
        currency=order.currency,
        description=description,
    )
