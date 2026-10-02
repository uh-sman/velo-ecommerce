"use client";

import type { Schema } from "@velo/api-client";
import { createContext, useContext } from "react";

import { can, type Permission } from "@/lib/permissions";

type Me = Schema<"MeView">;

const MeContext = createContext<Me | null>(null);

export function MeProvider({ me, children }: { me: Me; children: React.ReactNode }) {
  return <MeContext.Provider value={me}>{children}</MeContext.Provider>;
}

/** The signed-in staff member. Only usable inside the admin layout. */
export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error("useMe outside MeProvider");
  return me;
}

/** Whether the signed-in staff member has a permission — for hiding what they cannot use. */
export function useCan(permission: Permission): boolean {
  return can(useMe().permissions, permission);
}

/** Renders its children only for staff with the permission. */
export function IfCan({
  permission,
  children,
}: {
  permission: Permission;
  children: React.ReactNode;
}) {
  return useCan(permission) ? <>{children}</> : null;
}
