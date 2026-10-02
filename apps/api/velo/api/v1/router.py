"""v1 router.

Every domain router is mounted here as it arrives, in the order the domains are
listed in ARCHITECTURE.md §3.
"""

from __future__ import annotations

from fastapi import APIRouter

from velo.api.v1 import (
    account,
    admin_catalog,
    admin_inventory,
    admin_orders,
    auth,
    cart,
    catalog,
    checkout,
    orders,
    search,
    system,
    webhooks,
)

api_router = APIRouter()
api_router.include_router(system.router)
api_router.include_router(auth.router)
api_router.include_router(account.router)
api_router.include_router(catalog.router)
api_router.include_router(search.router)
api_router.include_router(cart.router)
api_router.include_router(checkout.router)
api_router.include_router(orders.router)
api_router.include_router(webhooks.router)
api_router.include_router(admin_catalog.router)
api_router.include_router(admin_inventory.router)
api_router.include_router(admin_orders.router)
