# ADR-008 — JWT in httpOnly cookies over localStorage tokens or server sessions

|              |                  |
| ------------ | ---------------- |
| **Status**   | Accepted         |
| **Date**     | 2026-09-20       |
| **Deciders** | Project lead     |
| **Related**  | ADR-003, ADR-010 |

---

## Context

Three clients need authenticated access: the storefront (Next.js, with Server Components that must read the session during server rendering), the admin dashboard (Next.js), and potentially a mobile app or integration (ADR-003's headless promise).

Two properties matter most. **XSS resistance:** a storefront pulls in analytics, payment scripts, and dependency trees, so the realistic threat is a script running in our own page reading a token. **Server-render access:** if the session lives in JavaScript-readable storage, a React Server Component cannot see it, and authenticated pages either lose SSR or need a second round trip.

There is also a commerce-specific requirement: a guest cart must survive, be cookie-bound, and merge into the account cart on login — so cookies are in the design regardless.

## Options considered

| Option                                | Summary                                                    | Verdict            |
| ------------------------------------- | ---------------------------------------------------------- | ------------------ |
| **A — JWT in httpOnly cookies**       | Short access token + rotating refresh token, both httpOnly | ✅ Chosen          |
| **B — JWT in `localStorage`**         | Token in JS-readable storage, `Authorization` header       | ❌ Rejected        |
| **C — Server-side sessions in Redis** | Opaque session ID cookie, state in Redis                   | ❌ Rejected        |
| **D — Third-party auth provider**     | Auth0 / Clerk / Supabase Auth                              | ❌ Rejected for v1 |

### A — JWT in httpOnly cookies

An access token with a short lifetime (15 minutes) and a refresh token with a long one (30 days, rotated on every use), both set `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`.

`HttpOnly` means injected JavaScript cannot read either token — the XSS token-theft path is closed by the browser, not by our diligence. Server Components read the cookie directly during render, so authenticated pages server-render with no extra hop. Verification stays stateless: signature plus claims, no datastore lookup on the hot path.

Refresh rotation provides the revocation story that stateless JWTs otherwise lack: each refresh issues a new token and invalidates its predecessor, and a replayed old refresh token signals theft and revokes the whole family.

`SameSite=Lax` plus a double-submit CSRF token on state-changing requests covers the cookie-borne CSRF risk that this approach introduces.

### B — JWT in `localStorage`

The common SPA pattern, and the reason a large share of session-hijacking incidents exist. Any script in the page — ours, a dependency's, or an injected one — can read `localStorage`. Server Components cannot read it at all, so authenticated SSR is lost.

Rejected. The convenience of attaching an `Authorization` header manually is not worth making token theft a one-line script.

### C — Server-side sessions in Redis

Genuinely strong on revocation: delete the key, the session is gone instantly, with no refresh-rotation machinery. The cost is that every authenticated request becomes a Redis round trip, and Redis moves from "cache that can fail open" to "hard dependency of every authenticated request" — which contradicts the degraded-mode design in `DISCOVERY.md` §7.2, where Redis being down must not take authentication with it.

Close, and the right answer for a system with strict instant-revocation requirements. Rejected here because rotation gets us most of the revocation benefit without adding a hard dependency to the auth path.

### D — Third-party auth provider

Removes real work — password reset, MFA, social login, breach monitoring — and would be a defensible choice. Rejected for v1 because it puts a third party in the login path of a store whose differentiator is owning its own correctness, adds per-MAU cost, and complicates self-hosting, which is an explicit product property. The auth module is a named seam; adopting a provider later replaces the module, not the sessions.

## Decision

**We will issue JWTs in httpOnly, Secure, SameSite=Lax cookies: a 15-minute access token and a 30-day refresh token rotated on every use, with reuse detection revoking the token family.** Admin sessions use a shorter refresh window (7 days) and require re-authentication for destructive operations.

The deciding reason is XSS resistance by browser enforcement rather than by discipline. Second: Server Components can read the session, so authenticated pages server-render without an extra round trip.

**Mobile and integration clients** use the same tokens in an `Authorization: Bearer` header — the API accepts either transport, while the browser clients are cookie-only. Integrations use scoped API keys instead of user tokens.

## Consequences

**Good**

- Token theft via XSS is closed off by `HttpOnly`, not by hoping no dependency is compromised.
- Authenticated SSR works with no client round trip.
- Access-token verification is stateless: no datastore read on the hot path.
- Refresh rotation with reuse detection gives revocation _and_ an active theft signal.
- Cookies are already required for guest carts, so there is one session mechanism, not two.

**Bad**

- CSRF becomes our problem. Cookies are sent automatically, so `SameSite=Lax` plus a double-submit token on every state-changing request is mandatory — and an endpoint that forgets it is a real vulnerability.
- Revocation is not instant: an access token stays valid for up to 15 minutes after a logout or a ban. Acceptable, and stated here so nobody assumes otherwise. Destructive admin actions re-check the user's live status to close the window where it matters.
- Refresh rotation needs a stored token family and careful handling of concurrent refreshes from parallel tabs — a known source of spurious logouts if implemented naively.
- Cross-origin setups need exact cookie domain and CORS configuration; a misconfiguration fails in a way that is confusing to debug.

**Neutral**

- Password hashing (Argon2id), lockout, and reset flows remain ours to implement (Phase 5).
- Refresh-token families live in Postgres, not Redis, keeping Redis non-essential to authentication.

## Revisit when

Instant revocation becomes a hard requirement (regulatory, or a high-value admin surface), MFA and social login costs exceed what a provider would charge, or a mobile app's session needs diverge enough to warrant a separate scheme.
