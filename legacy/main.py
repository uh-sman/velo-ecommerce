from fastapi import FastAPI, Request, Header, HTTPException, BackgroundTasks
from models import LoyverseOrder, ChargePayload
from cloudbeds import CloudbedsClient
from loyverse import verify_signature, order_to_charge
from tasks import enqueue_post_charge
import os

app = FastAPI(title="Loyverse ↔ Cloudbeds Bridge")

cb = CloudbedsClient(
    base_url=os.getenv("CLOUDBEDS_BASE_URL"),
    api_token=os.getenv("CLOUDBEDS_API_TOKEN"),
)


@app.get("/guests")
async def get_guests(hotel_id: str):
    """Proxy to Cloudbeds `getInHouseReservations` (simple wrapper)."""
    return await cb.get_in_house_reservations(hotel_id)


@app.post("/webhook/loyverse")
async def loyverse_webhook(request: Request, x_loyverse_sig: str = Header(None), background_tasks: BackgroundTasks = None):
    payload = await request.json()
    secret = os.getenv("LOYVERSE_WEBHOOK_SECRET", "change-me")
    if not verify_signature(payload, x_loyverse_sig or "", secret):
        raise HTTPException(status_code=401, detail="Invalid signature")

    order = LoyverseOrder.parse_obj(payload)
    charge = order_to_charge(order)

    # Enqueue for reliable delivery (Celery preferred, falls back to background task)
    enqueue_post_charge(charge.dict())

    return {"status": "accepted"}


@app.post("/post_charge_direct")
async def post_charge_direct(charge: ChargePayload):
    """Direct POST endpoint for testing: posts immediately to Cloudbeds."""
    result = await cb.post_add_charge(charge.dict())
    return result
