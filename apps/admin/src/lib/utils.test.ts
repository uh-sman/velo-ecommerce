import { describe, expect, it } from "vitest";

import { can } from "@/lib/permissions";
import { apiUrl, cn, formatDate } from "@/lib/utils";

describe("cn", () => {
  it("joins classes and lets later Tailwind utilities win", () => {
    const hidden = false;
    expect(cn("px-2 py-1", hidden && "hidden", ["text-sm"], "px-4")).toBe("py-1 text-sm px-4");
  });
});

describe("apiUrl", () => {
  it("prefixes the configured API origin", () => {
    expect(apiUrl("/api/v1/orders/1/invoice.pdf")).toBe(
      "http://localhost:8000/api/v1/orders/1/invoice.pdf",
    );
  });
});

describe("formatDate", () => {
  it("formats an ISO timestamp as a day, short month and year", () => {
    const text = formatDate("2026-03-05T12:00:00Z");
    expect(text).toMatch(/2026/);
    expect(text).toMatch(/5/);
    expect(text).toMatch(/Mar/);
  });
});

describe("can", () => {
  it("is true only for a permission in the list", () => {
    expect(can(["orders:read"], "orders:read")).toBe(true);
    expect(can(["orders:read"], "orders:refund")).toBe(false);
    expect(can([], "admin:access")).toBe(false);
  });
});
