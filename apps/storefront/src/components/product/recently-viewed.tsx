"use client";

import type { Schema } from "@velo/api-client";
import { useEffect, useState } from "react";

import { ProductGrid } from "@/components/commerce/product-card";
import { callApi } from "@/lib/api-browser";
import { recall, RECENTLY_VIEWED, remember } from "@/lib/recent";

type Card = Schema<"ProductCard">;

/**
 * Records this product as viewed, and shows up to four others viewed before
 * it. Kept in this browser only; the cards come from the search index by slug.
 */
export function RecentlyViewed({ current }: { current: Card }) {
  const [cards, setCards] = useState<Card[]>([]);

  useEffect(() => {
    const earlier = recall(RECENTLY_VIEWED).filter((slug) => slug !== current.slug);
    remember(RECENTLY_VIEWED, current.slug, 12);
    const wanted = earlier.slice(0, 4);
    if (wanted.length === 0) return;
    void Promise.all(
      wanted.map((slug) =>
        callApi((client) => client.GET("/api/v1/products/{slug}", { params: { path: { slug } } })),
      ),
    ).then((outcomes) => {
      setCards(
        outcomes.flatMap((outcome) => {
          if (!outcome.ok) return [];
          const product = outcome.data;
          const variant = product.variants[0];
          if (!variant) return [];
          const prices = product.variants.map((v) => v.price.amount);
          return [
            {
              id: product.id,
              slug: product.slug,
              title: product.title,
              subtitle: product.subtitle,
              brand: product.brand,
              image: product.media[0] ?? null,
              price: { ...variant.price, amount: Math.min(...prices) },
              price_max: { ...variant.price, amount: Math.max(...prices) },
              compare_at: variant.compare_at,
              rating: product.rating,
              in_stock: product.in_stock,
              published_at: null,
            } satisfies Card,
          ];
        }),
      );
    });
  }, [current.slug]);

  if (cards.length === 0) return null;
  return (
    <section aria-labelledby="recent-heading" className="flex flex-col gap-6">
      <h2 id="recent-heading" className="text-2xl font-semibold tracking-tight">
        Recently viewed
      </h2>
      <ProductGrid cards={cards} />
    </section>
  );
}
