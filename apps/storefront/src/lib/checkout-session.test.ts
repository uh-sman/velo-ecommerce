import { afterEach, describe, expect, it, vi } from "vitest";

import { forgetCheckout, rememberCheckout, rememberedCheckout } from "@/lib/checkout-session";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("checkout-session", () => {
  it("remembers, recalls and forgets the checkout id in sessionStorage", () => {
    expect(rememberedCheckout()).toBeNull();
    rememberCheckout("chk_123");
    expect(rememberedCheckout()).toBe("chk_123");
    expect(sessionStorage.getItem("velo:checkout")).toBe("chk_123");
    forgetCheckout();
    expect(rememberedCheckout()).toBeNull();
  });

  it("degrades quietly when storage is unavailable", () => {
    const boom = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(boom);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(boom);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(boom);
    expect(() => {
      rememberCheckout("chk_123");
    }).not.toThrow();
    expect(rememberedCheckout()).toBeNull();
    expect(() => {
      forgetCheckout();
    }).not.toThrow();
  });
});
