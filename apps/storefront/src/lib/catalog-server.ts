/**
 * Catalog reads for Server Components. Public data — no cookies forwarded —
 * revalidated every minute, so listing pages are fast and still fresh.
 */

import type { Schema } from "@velo/api-client";

import { publicClient } from "@/lib/api-server";
import { apiQuery, type ListingState } from "@/lib/listing";

type Card = Schema<"ProductCard">;

export interface ListingScope {
  category?: string;
  collection?: string;
}

export async function loadListing(
  scope: ListingScope,
  state: ListingState,
): Promise<{ cards: Card[]; nextCursor: string | null; failed: boolean }> {
  try {
    const { data } = await publicClient().GET("/api/v1/products", {
      params: { query: { ...apiQuery(state), ...scope } },
      next: { revalidate: 60 },
    });
    if (!data) return { cards: [], nextCursor: null, failed: true };
    return { cards: data.data, nextCursor: data.pagination.next_cursor ?? null, failed: false };
  } catch {
    return { cards: [], nextCursor: null, failed: true };
  }
}

/** Brand filter options for a scope, from the search facets. Empty if search is down. */
export async function brandOptions(scope: ListingScope): Promise<string[]> {
  try {
    const { data } = await publicClient().GET("/api/v1/search", {
      params: {
        query: {
          limit: 1,
          ...(scope.category ? { category: [scope.category] } : {}),
          ...(scope.collection ? { collection: [scope.collection] } : {}),
        },
      },
      next: { revalidate: 300 },
    });
    return Object.keys(data?.facets["brand"] ?? {}).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export async function newArrivals(limit = 8): Promise<Card[]> {
  try {
    const { data } = await publicClient().GET("/api/v1/products", {
      params: { query: { sort: "newest", limit } },
      next: { revalidate: 60 },
    });
    return data?.data ?? [];
  } catch {
    return [];
  }
}

export async function collectionProducts(slug: string, limit = 4): Promise<Card[]> {
  try {
    const { data } = await publicClient().GET("/api/v1/products", {
      params: { query: { collection: slug, limit, sort: "newest" } },
      next: { revalidate: 60 },
    });
    return data?.data ?? [];
  } catch {
    return [];
  }
}
