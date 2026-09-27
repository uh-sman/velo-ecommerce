import os
import httpx

class CloudbedsClient:
    def __init__(self, base_url: str = None, api_token: str = None):
        self.base_url = base_url or os.getenv("CLOUDBEDS_BASE_URL")
        self.api_token = api_token or os.getenv("CLOUDBEDS_API_TOKEN")
        self.headers = {"Authorization": f"Bearer {self.api_token}", "Content-Type": "application/json"}

    async def get_in_house_reservations(self, hotel_id: str):
        url = f"{self.base_url}/getInHouseReservations"
        params = {"hotel_id": hotel_id}
        async with httpx.AsyncClient(timeout=10.0) as c:
            r = await c.get(url, params=params, headers=self.headers)
            r.raise_for_status()
            return r.json()

    async def post_add_charge(self, charge: dict):
        url = f"{self.base_url}/postAddCharge"
        async with httpx.AsyncClient(timeout=10.0) as c:
            r = await c.post(url, json=charge, headers=self.headers)
            r.raise_for_status()
            return r.json()
