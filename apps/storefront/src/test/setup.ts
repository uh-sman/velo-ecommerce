import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, vi } from "vitest";

import { resetNavigation } from "./navigation";
import { server } from "./server";

vi.mock("next/navigation", async () => (await import("./navigation")).navigationMock);

/*
 * Browser APIs jsdom lacks that Radix primitives (dialogs, selects, menus,
 * popovers) call. No-ops are enough: layout is not under test here.
 */
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
globalThis.ResizeObserver ??= NoopObserver as unknown as typeof ResizeObserver;
globalThis.IntersectionObserver ??= NoopObserver as unknown as typeof IntersectionObserver;
const elementShims: Record<string, (...args: unknown[]) => unknown> = {
  scrollIntoView: () => undefined,
  hasPointerCapture: () => false,
  setPointerCapture: () => undefined,
  releasePointerCapture: () => undefined,
};
for (const [name, shim] of Object.entries(elementShims)) {
  if (!(name in Element.prototype)) {
    Object.defineProperty(Element.prototype, name, {
      value: shim,
      configurable: true,
      writable: true,
    });
  }
}
// jsdom declares `matchMedia` but leaves it undefined, so test the type, not the key.
if (typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  });
}

beforeAll(() => {
  // An unmocked request is a test bug: fail loudly instead of hitting a network.
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetNavigation();
  document.cookie.split("; ").forEach((part) => {
    const name = part.split("=")[0];
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  });
  localStorage.clear();
  sessionStorage.clear();
});

afterAll(() => {
  server.close();
});
