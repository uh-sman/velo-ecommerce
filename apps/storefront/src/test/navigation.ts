/**
 * A stand-in for `next/navigation`, which needs the App Router's context and
 * so cannot run outside `next dev`. `setup.ts` installs it for every test.
 *
 * Tests set the URL with `setNavigation(...)` and assert on `router.push` etc.
 */

import { vi } from "vitest";

export const router = {
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
};

const state = { pathname: "/", searchParams: new URLSearchParams() };

export function setNavigation({
  pathname = "/",
  search = "",
}: { pathname?: string; search?: string | Record<string, string> } = {}) {
  state.pathname = pathname;
  state.searchParams = new URLSearchParams(search);
}

export function resetNavigation() {
  setNavigation();
  for (const fn of Object.values(router)) fn.mockReset();
}

export const navigationMock = {
  useRouter: () => router,
  usePathname: () => state.pathname,
  useSearchParams: () => state.searchParams,
  useParams: () => ({}),
  redirect: vi.fn(),
  notFound: vi.fn(),
};
