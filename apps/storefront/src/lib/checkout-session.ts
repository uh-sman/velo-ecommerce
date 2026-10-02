/**
 * Which checkout this tab is in. Only the id is kept — it grants nothing on
 * its own: ownership is the httpOnly `velo_checkout` cookie (API-SPEC.md §2).
 * sessionStorage, so a checkout does not follow the customer into a new tab
 * days later; storage can throw (private mode), so every access is guarded.
 */

const KEY = "velo:checkout";

export function rememberedCheckout(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function rememberCheckout(id: string): void {
  try {
    sessionStorage.setItem(KEY, id);
  } catch {
    // Without storage the customer restarts checkout on reload; nothing breaks.
  }
}

export function forgetCheckout(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // As above.
  }
}
