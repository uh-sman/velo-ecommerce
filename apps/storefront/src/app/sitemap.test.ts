import { HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { aCategory } from "@/test/fixtures/account";
import { productCard } from "@/test/fixtures/commerce";
import { ok, on, server } from "@/test/server";

import sitemap from "./sitemap";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ toString: () => "" }) }));

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://shop.example.com");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function page(slugs: string[], next: string | null) {
  return {
    data: slugs.map((slug) => productCard({ id: slug, slug })),
    pagination: { has_more: next !== null, next_cursor: next, limit: 100, total_count: null },
  };
}

describe("sitemap.xml", () => {
  it("lists the fixed pages, every category, collection and product", async () => {
    const cursors: (string | null)[] = [];
    server.use(
      ok("get", "/api/v1/categories", [aCategory("Men", [aCategory("Knitwear")])]),
      ok("get", "/api/v1/collections", [
        { id: "c1", slug: "summer", title: "Summer", description: null },
      ]),
      on("get", "/api/v1/products", ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("cursor");
        cursors.push(cursor);
        return HttpResponse.json(cursor ? page(["tote"], null) : page(["tee", "cap"], "p2"));
      }),
    );

    const urls = (await sitemap()).map((entry) => entry.url);

    expect(cursors).toEqual([null, "p2"]); // walked the catalog to the end
    expect(urls).toEqual(
      expect.arrayContaining([
        "https://shop.example.com/",
        "https://shop.example.com/products",
        "https://shop.example.com/categories/men",
        "https://shop.example.com/categories/knitwear",
        "https://shop.example.com/collections/summer",
        "https://shop.example.com/products/tee",
        "https://shop.example.com/products/cap",
        "https://shop.example.com/products/tote",
      ]),
    );
    expect(urls.some((url) => url.includes("/account") || url.includes("/checkout"))).toBe(false);
  });

  it("still serves the fixed pages when the API is down", async () => {
    server.use(
      on("get", "/api/v1/categories", () => HttpResponse.error()),
      on("get", "/api/v1/collections", () => HttpResponse.error()),
      on("get", "/api/v1/products", () => HttpResponse.error()),
    );

    const urls = (await sitemap()).map((entry) => entry.url);

    expect(urls).toContain("https://shop.example.com/");
    expect(urls.some((url) => url.includes("/products/"))).toBe(false);
  });
});
