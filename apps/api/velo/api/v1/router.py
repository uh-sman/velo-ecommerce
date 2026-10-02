"""v1 router.

Every domain router is mounted here as it arrives, in the order the domains are
listed in ARCHITECTURE.md §3.
"""

from __future__ import annotations

from fastapi import APIRouter

from velo.api.v1 import (
    account,
    admin_catalog,
    admin_customers,
    admin_discounts,
    admin_insights,
    admin_inventory,
    admin_orders,
    admin_settings,
    admin_staff,
    auth,
    cart,
    catalog,
    checkout,
    email,
    orders,
    sandbox,
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
# 404 unless VELO_PAYMENT_SANDBOX is on; mounted always so the typed client knows it.
api_router.include_router(sandbox.router)
api_router.include_router(email.router)
api_router.include_router(admin_catalog.router)
api_router.include_router(admin_inventory.router)
api_router.include_router(admin_orders.router)
api_router.include_router(admin_customers.router)
api_router.include_router(admin_discounts.router)
api_router.include_router(admin_settings.router)
api_router.include_router(admin_staff.router)
api_router.include_router(admin_insights.router)
