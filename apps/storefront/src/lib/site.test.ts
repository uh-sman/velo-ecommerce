import { afterEach, describe, expect, it, vi } from "vitest";

import { absoluteUrl, breadcrumbList, siteStructuredData, siteUrl } from "./site";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("site URLs", () => {
  it("defaults to the local storefront", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", undefined);
    expect(siteUrl()).toBe("http://localhost:3000");
  });

  it("uses the configured origin without a trailing slash", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://shop.example.com/");
    expect(absoluteUrl("/products/tote")).toBe("https://shop.example.com/products/tote");
    expect(absoluteUrl("cart")).toBe("https://shop.example.com/cart");
    expect(absoluteUrl()).toBe("https://shop.example.com/");
  });
});

describe("structured data", () => {
  it("numbers a breadcrumb trail from Home with absolute URLs", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://shop.example.com");
    const list = breadcrumbList([
      { name: "Knitwear", path: "/categories/knitwear" },
      { name: "Merino Crew", path: "/products/merino-crew" },
    ]);
    expect(list["@type"]).toBe("BreadcrumbList");
    expect(list["itemListElement"]).toEqual([
      { "@type": "ListItem", position: 1, name: "Home", item: "https://shop.example.com/" },
      {
        "@type": "ListItem",
        position: 2,
        name: "Knitwear",
        item: "https://shop.example.com/categories/knitwear",
      },
      {
        "@type": "ListItem",
        position: 3,
        name: "Merino Crew",
        item: "https://shop.example.com/products/merino-crew",
      },
    ]);
  });

  it("describes the organisation and the site search", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://shop.example.com");
    const [organization, website] = siteStructuredData();
    expect(organization).toMatchObject({ "@type": "Organization", name: "Velo" });
    expect(website).toMatchObject({
      "@type": "WebSite",
      potentialAction: {
        target: { urlTemplate: "https://shop.example.com/search?q={q}" },
      },
    });
  });
});
