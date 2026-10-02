import { describe, expect, it } from "vitest";

import { COUNTRIES, layoutFor } from "@/lib/countries";

describe("countries", () => {
  it("finds a layout case-insensitively", () => {
    const us = layoutFor("us");
    expect(us.name).toBe("United States");
    expect(us.region).toEqual({ label: "State", required: true });
    expect(us.postal?.pattern.test("94103-1234")).toBe(true);
    expect(us.postal?.pattern.test("9410")).toBe(false);
  });

  it("falls back to a generic layout for an unknown country", () => {
    const layout = layoutFor("XX");
    expect(layout).toMatchObject({ code: "XX", name: "XX" });
    expect(layout.region?.required).toBe(false);
    expect(layout.postal?.pattern.test("AB-123")).toBe(true);
  });

  it("has no postcode or region where the country has none", () => {
    expect(layoutFor("NG").postal).toBeNull();
    expect(layoutFor("DE").region).toBeNull();
  });

  it("gives each listed postcode pattern an example it accepts", () => {
    for (const country of COUNTRIES) {
      if (country.postal) expect(country.postal.pattern.test(country.postal.example)).toBe(true);
    }
  });
});
