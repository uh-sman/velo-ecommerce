"""Roles and permissions (RBAC).

Five fixed roles in ``users.role``. What each may do is defined here, in code,
where a change is a reviewed diff with a test — not a row an operator can edit
in production. Routes depend on a *permission*, never on a role name, so
reshaping a role never means hunting through handlers.
"""

from __future__ import annotations

from enum import StrEnum


class Role(StrEnum):
    CUSTOMER = "customer"
    FULFILMENT = "fulfilment"
    STAFF = "staff"
    ADMIN = "admin"
    OWNER = "owner"


class Permission(StrEnum):
    ADMIN_ACCESS = "admin:access"  # can sign in to the admin dashboard at all
    ORDERS_READ = "orders:read"
    ORDERS_FULFIL = "orders:fulfil"
    ORDERS_REFUND = "orders:refund"
    INVENTORY_WRITE = "inventory:write"
    CATALOG_WRITE = "catalog:write"
    DISCOUNTS_WRITE = "discounts:write"
    CUSTOMERS_READ = "customers:read"
    CUSTOMERS_WRITE = "customers:write"
    REPORTS_READ = "reports:read"
    STAFF_MANAGE = "staff:manage"
    SETTINGS_MANAGE = "settings:manage"
    AUDIT_READ = "audit:read"  # who did what, across the whole admin


_FULFILMENT = frozenset(
    {
        Permission.ADMIN_ACCESS,
        Permission.ORDERS_READ,
        Permission.ORDERS_FULFIL,
        Permission.INVENTORY_WRITE,
    }
)
_STAFF = _FULFILMENT | {
    Permission.CATALOG_WRITE,
    Permission.DISCOUNTS_WRITE,
    Permission.CUSTOMERS_READ,
    Permission.REPORTS_READ,
}
_ADMIN = _STAFF | {Permission.ORDERS_REFUND, Permission.CUSTOMERS_WRITE, Permission.AUDIT_READ}
_OWNER = frozenset(Permission)

ROLE_PERMISSIONS: dict[Role, frozenset[Permission]] = {
    Role.CUSTOMER: frozenset(),
    Role.FULFILMENT: _FULFILMENT,
    Role.STAFF: frozenset(_STAFF),
    Role.ADMIN: frozenset(_ADMIN),
    Role.OWNER: _OWNER,
}

# Staff roles get a 7-day refresh window instead of 30 (ADR-008).
STAFF_ROLES = frozenset({Role.FULFILMENT, Role.STAFF, Role.ADMIN, Role.OWNER})


def permissions_for(role: str) -> frozenset[Permission]:
    """Unknown roles get nothing — fail closed."""
    try:
        return ROLE_PERMISSIONS[Role(role)]
    except ValueError:
        return frozenset()


def has_permission(role: str, permission: Permission) -> bool:
    return permission in permissions_for(role)


def is_staff(role: str) -> bool:
    try:
        return Role(role) in STAFF_ROLES
    except ValueError:
        return False
