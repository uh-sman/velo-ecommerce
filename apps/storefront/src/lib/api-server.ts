/**
 * Calling the API from Server Components.
 *
 * The browser sends the API's cookies to this app too — cookies are scoped by
 * host, not port, and by the shared parent domain in production — so a Server
 * Component can forward them and render as the signed-in customer, with no
 * client round trip (ADR-008).
 *
 * What a server render cannot do is refresh: the refresh cookie is scoped to
 * the API's `/auth/refresh` path and never reaches this app. An expired access
 * token therefore renders a signed-out result, and the page's
 * `SessionRecovery` client component refreshes in the browser and re-renders.
 */

import { createApiClient, type Schema } from "@velo/api-client";
import { cookies } from "next/headers";
import { cache } from "react";

export type SessionUser = Schema<"UserResponse">;

export async function serverClient() {
  const jar = await cookies();
  return createApiClient({ headers: { cookie: jar.toString() } });
}

/**
 * The signed-in user, or null if there is no valid access token (or no API).
 * Memoised per request: the header and the page share one lookup.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  try {
    const { data } = await (await serverClient()).GET("/api/v1/auth/me", { cache: "no-store" });
    return data ?? null;
  } catch {
    return null;
  }
});
