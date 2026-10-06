import type { MetadataRoute } from "next";

import { type CategoryNode, getCategoryTree, getCollections, publicClient } from "@/lib/api-server";
import { absoluteUrl } from "@/lib/site";

// Rebuilt at most hourly: a new product reaches the sitemap within the hour,
// and a crawler fetching it often costs one catalog walk, not one per fetch.
export const revalidate = 3600;

const PAGE_SIZE = 100; // the API's maximum
const MAX_URLS = 50_000; // the sitemap protocol's limit for one file

/** Every published product's slug, walking the cursor until the catalog ends. */
async function productSlugs(limit: number): Promise<string[]> {
  const slugs: string[] = [];
  let cursor: string | undefined;
  while (slugs.length < limit) {
    const { data } = await publicClient().GET("/api/v1/products", {
      params: { query: { limit: PAGE_SIZE, sort: "newest", ...(cursor ? { cursor } : {}) } },
      next: { revalidate },
    });
    if (!data) break;
    slugs.push(...data.data.map((product) => product.slug));
    if (!data.pagination.has_more || !data.pagination.next_cursor) break;
    cursor = data.pagination.next_cursor;
  }
  return slugs.slice(0, limit);
}

function flatten(nodes: CategoryNode[]): string[] {
  return nodes.flatMap((node) => [node.slug, ...flatten(node.children)]);
}

/**
 * Pages worth indexing: home, listings, every category, collection and
 * product. Account, cart, checkout and order pages are left out — they are
 * private, and robots.ts keeps crawlers away from them.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [categories, collections] = await Promise.all([getCategoryTree(), getCollections()]);
  const fixed: MetadataRoute.Sitemap = [
    { url: absoluteUrl("/"), changeFrequency: "daily", priority: 1 },
    { url: absoluteUrl("/products"), changeFrequency: "daily", priority: 0.8 },
    { url: absoluteUrl("/collections"), changeFrequency: "weekly", priority: 0.5 },
    { url: absoluteUrl("/help/shipping"), changeFrequency: "monthly", priority: 0.2 },
    { url: absoluteUrl("/help/returns"), changeFrequency: "monthly", priority: 0.2 },
    ...flatten(categories).map((slug) => ({
      url: absoluteUrl(`/categories/${slug}`),
      changeFrequency: "daily" as const,
      priority: 0.7,
    })),
    ...collections.map((collection) => ({
      url: absoluteUrl(`/collections/${collection.slug}`),
      changeFrequency: "weekly" as const,
      priority: 0.6,
    })),
  ];

  let products: string[] = [];
  try {
    products = await productSlugs(MAX_URLS - fixed.length);
  } catch {
    // The API is down: serve what we have rather than an error page.
  }
  return [
    ...fixed,
    ...products.map((slug) => ({
      url: absoluteUrl(`/products/${slug}`),
      changeFrequency: "weekly" as const,
      priority: 0.9,
    })),
  ];
}
