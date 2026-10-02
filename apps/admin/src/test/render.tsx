/**
 * Render inside the admin layout's `MeProvider`, as every admin component is.
 *
 * `staff()` defaults to an owner with every permission; pass `permissions` to
 * prove that a role without one does not see the control it cannot use.
 */

import { render, type RenderOptions } from "@testing-library/react";
import type { Schema } from "@velo/api-client";
import type { ReactElement } from "react";

import { MeProvider } from "@/components/shell/me-context";
import type { Permission } from "@/lib/permissions";

export const ALL_PERMISSIONS: Permission[] = [
  "admin:access",
  "orders:read",
  "orders:fulfil",
  "orders:refund",
  "inventory:write",
  "catalog:write",
  "discounts:write",
  "customers:read",
  "customers:write",
  "reports:read",
  "staff:manage",
  "settings:manage",
  "audit:read",
];

export function staff(overrides: Partial<Schema<"MeView">> = {}): Schema<"MeView"> {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    email: "owner@velo.test",
    first_name: "Olu",
    last_name: "Owner",
    role: "owner",
    permissions: ALL_PERMISSIONS,
    store_currency: "USD",
    ...overrides,
  };
}

export function renderWithMe(
  ui: ReactElement,
  { me = staff(), ...options }: { me?: Schema<"MeView"> } & Omit<RenderOptions, "wrapper"> = {},
) {
  return render(ui, {
    ...options,
    wrapper: ({ children }) => <MeProvider me={me}>{children}</MeProvider>,
  });
}
