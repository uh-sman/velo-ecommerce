from pydantic import BaseModel
from typing import List, Optional, Any

class LoyverseItem(BaseModel):
    id: str
    name: str
    quantity: float
    price: float

class LoyverseOrder(BaseModel):
    id: str
    total: float
    currency: Optional[str]
    items: List[LoyverseItem]
    meta: Optional[dict] = None  # expect room_number or reservation_id in metadata


class ChargePayload(BaseModel):
    reservation_id: Optional[str]
    room_number: Optional[str]
    amount: float
    currency: Optional[str]
    description: Optional[str]
    source: Optional[str] = "loyverse"
