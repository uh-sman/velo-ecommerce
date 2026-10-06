import { afterEach, describe, expect, it, vi } from "vitest";

import robots from "./robots";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("robots.txt", () => {
  it("lets crawlers into the catalog but not private pages, and names the sitemap", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://shop.example.com");
    vi.stubEnv("NEXT_PUBLIC_SITE_NOINDEX", "");
    const result = robots();
    expect(result.sitemap).toBe("https://shop.example.com/sitemap.xml");
    const rules = Array.isArray(result.rules) ? result.rules[0] : result.rules;
    expect(rules?.allow).toBe("/");
    expect(rules?.disallow).toEqual(expect.arrayContaining(["/account", "/checkout", "/cart"]));
  });

  it("shuts everything off on staging", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_NOINDEX", "1");
    expect(robots()).toEqual({ rules: { userAgent: "*", disallow: "/" } });
  });
});
