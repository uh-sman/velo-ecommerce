/**
 * Permissions as the admin UI uses them. The API is the authority — every
 * route checks for itself — so this only decides what to *show*: a menu item
 * or a button the role cannot use is hidden rather than offered and refused.
 */

export type Permission =
  | "admin:access"
  | "orders:read"
  | "orders:fulfil"
  | "orders:refund"
  | "inventory:write"
  | "catalog:write"
  | "discounts:write"
  | "customers:read"
  | "customers:write"
  | "reports:read"
  | "staff:manage"
  | "settings:manage"
  | "audit:read";

export function can(permissions: readonly string[], permission: Permission): boolean {
  return permissions.includes(permission);
}
