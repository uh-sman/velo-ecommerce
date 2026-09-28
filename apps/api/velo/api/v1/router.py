"""v1 router.

Every domain router is mounted here as it arrives, in the order the domains are
listed in ARCHITECTURE.md §3.
"""

from __future__ import annotations

from fastapi import APIRouter

from velo.api.v1 import account, auth, system

api_router = APIRouter()
api_router.include_router(system.router)
api_router.include_router(auth.router)
api_router.include_router(account.router)

# Phase 6+ mount here: catalog, inventory, cart, discounts, shipping,
# checkout, payments, orders, admin.
