import { describe, expect, it } from "vitest";

import { GROUPS, NAV, sectionOf } from "@/components/shell/nav";

describe("NAV", () => {
  it("has unique hrefs, each in a known group", () => {
    const hrefs = NAV.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const item of NAV) expect(GROUPS).toContain(item.group);
  });
});

describe("sectionOf", () => {
  it.each([
    ["/", "Dashboard"],
    ["/orders", "Orders"],
    ["/orders/123", "Orders"],
    ["/products/abc", "Products"],
    ["/products/import", "Import products"],
    ["/products/import/history", "Import products"],
    ["/settings/tax", "Settings"],
  ])("puts %s under %s", (pathname, label) => {
    expect(sectionOf(pathname)?.label).toBe(label);
  });

  it("matches the dashboard only at the root", () => {
    expect(sectionOf("/unknown")).toBeUndefined();
  });
});
