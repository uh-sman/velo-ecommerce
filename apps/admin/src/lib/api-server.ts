/**
 * Calling the API from the admin's Server Components, as the signed-in staff
 * member: the browser's cookies are forwarded (ADR-008). A server render cannot
 * refresh an expired access token — `SessionGate` does that in the browser.
 */

import { createApiClient, type Schema } from "@velo/api-client";
import { cookies } from "next/headers";
import { cache } from "react";

export type Me = Schema<"MeView">;

export async function serverClient() {
  const jar = await cookies();
  return createApiClient({ headers: { cookie: jar.toString() } });
}

/**
 * Who is signed in to the admin, with their permissions.
 * `null`: no valid session (or the API is down). `"forbidden"`: signed in,
 * but the account has no admin access.
 */
export const getMe = cache(async (): Promise<Me | null | "forbidden"> => {
  try {
    const { data, response } = await (
      await serverClient()
    ).GET("/api/v1/admin/me", { cache: "no-store" });
    if (response.status === 403) return "forbidden";
    return data ?? null;
  } catch {
    return null;
  }
});
