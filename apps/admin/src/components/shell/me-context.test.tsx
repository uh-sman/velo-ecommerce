import { render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IfCan, MeProvider, useCan, useMe } from "@/components/shell/me-context";
import { renderWithMe, staff } from "@/test/render";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useMe", () => {
  it("returns the signed-in staff member", () => {
    const me = staff({ email: "sam@velo.test" });
    const { result } = renderHook(() => useMe(), {
      wrapper: ({ children }) => <MeProvider me={me}>{children}</MeProvider>,
    });
    expect(result.current).toBe(me);
  });

  it("throws outside the provider", () => {
    // React logs the uncaught render error; keep the test output quiet.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => renderHook(() => useMe())).toThrow("useMe outside MeProvider");
  });
});

describe("useCan", () => {
  it("reflects the staff member's permissions", () => {
    const me = staff({ permissions: ["orders:read"] });
    const { result } = renderHook(
      () => ({ read: useCan("orders:read"), refund: useCan("orders:refund") }),
      { wrapper: ({ children }) => <MeProvider me={me}>{children}</MeProvider> },
    );
    expect(result.current).toEqual({ read: true, refund: false });
  });

  it("throws outside the provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => renderHook(() => useCan("orders:read"))).toThrow("useMe outside MeProvider");
  });
});

describe("IfCan", () => {
  it("renders its children for staff with the permission", () => {
    renderWithMe(
      <IfCan permission="orders:refund">
        <button type="button">Refund</button>
      </IfCan>,
    );
    expect(screen.getByRole("button", { name: "Refund" })).toBeInTheDocument();
  });

  it("renders nothing for staff without it", () => {
    renderWithMe(
      <IfCan permission="orders:refund">
        <button type="button">Refund</button>
      </IfCan>,
      { me: staff({ role: "support", permissions: ["admin:access", "orders:read"] }) },
    );
    expect(screen.queryByRole("button", { name: "Refund" })).not.toBeInTheDocument();
  });

  it("throws outside the provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<IfCan permission="orders:read">x</IfCan>)).toThrow(
      "useMe outside MeProvider",
    );
  });
});
