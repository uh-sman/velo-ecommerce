import { describe, expect, it } from "vitest";

import { apiUrl, cn, formatDate } from "@/lib/utils";

describe("utils", () => {
  it("merges conflicting Tailwind classes, later wins", () => {
    expect(cn("px-2 py-1", false, "px-4")).toBe("py-1 px-4");
  });

  it("builds absolute API URLs", () => {
    expect(apiUrl("/api/v1/orders/1/invoice.pdf")).toBe(
      "http://localhost:8000/api/v1/orders/1/invoice.pdf",
    );
  });

  it("formats a date with day, short month and year", () => {
    expect(formatDate("2026-03-05T12:00:00Z")).toBe(
      new Date("2026-03-05T12:00:00Z").toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
    );
    expect(formatDate("2026-03-05T12:00:00Z")).toMatch(/2026/);
  });
});
