"use client";

import type { Schema } from "@velo/api-client";
import { HeartIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { announceCart, openCart } from "@/components/commerce/cart-events";
import { PriceDisplay, RatingStars } from "@/components/commerce/price";
import { useWishlist } from "@/components/commerce/wishlist-context";
import { notify } from "@/components/ui/sonner";
import { callApi, fieldErrors } from "@/lib/api-browser";
import { cn } from "@/lib/utils";
import { CatalogImage } from "@/components/commerce/catalog-image";

type Card = Schema<"ProductCard">;

/*
 * DESIGN-SYSTEM.md §4 "ProductCard": image with a hover state, title, price
 * with compare-at, rating, quick-add, and the wishlist heart. Quick-add adds
 * directly when the product has one purchasable variant; with a choice to
 * make it goes to the product page instead of guessing a size.
 */
export function ProductCard({
  card,
  priority = false,
  headingLevel = "h3",
}: {
  card: Card;
  priority?: boolean;
  headingLevel?: "h2" | "h3";
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const wishlist = useWishlist();
  const saved = wishlist.has(card.id);
  const Heading = headingLevel;

  async function quickAdd() {
    setAdding(true);
    const detail = await callApi((client) =>
      client.GET("/api/v1/products/{slug}", { params: { path: { slug: card.slug } } }),
    );
    const buyable = detail.ok ? detail.data.variants.filter((v) => v.availability.in_stock) : [];
    const only =
      buyable.length === 1 && detail.ok && detail.data.variants.length === 1 ? buyable[0] : null;
    if (!only) {
      setAdding(false);
      router.push(`/products/${card.slug}`);
      return;
    }
    const added = await callApi((client) =>
      client.POST("/api/v1/cart/items", { body: { variant_id: only.id, quantity: 1 } }),
    );
    setAdding(false);
    if (added.ok) {
      announceCart(added.data);
      openCart();
    } else {
      notify.error(Object.values(fieldErrors(added.problem))[0] ?? added.problem.title);
    }
  }

  return (
    <article className="group relative flex flex-col gap-2">
      <div className="bg-surface-sunken relative aspect-[4/5] overflow-hidden rounded-md">
        {card.image ? (
          <CatalogImage
            media={card.image}
            alt={card.image.alt_text ?? ""}
            priority={priority}
            sizes="(min-width: 1280px) 20vw, (min-width: 1024px) 25vw, (min-width: 640px) 33vw, 50vw"
            className="object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : null}
        {!card.in_stock && (
          <span className="bg-surface-raised absolute left-2 top-2 rounded-sm px-2 py-0.5 text-xs font-medium">
            Sold out
          </span>
        )}
        <button
          type="button"
          onClick={() => void wishlist.toggle(card.id, card.title)}
          aria-pressed={saved}
          aria-label={
            saved ? `Remove ${card.title} from wishlist` : `Save ${card.title} to wishlist`
          }
          className="bg-surface-raised/90 hover:bg-surface-raised absolute right-2 top-2 z-10 flex size-10 items-center justify-center rounded-full shadow-sm"
        >
          <HeartIcon className={cn("size-5", saved && "fill-sale text-sale")} aria-hidden />
        </button>
        {card.in_stock && (
          <button
            type="button"
            onClick={() => void quickAdd()}
            disabled={adding}
            aria-label={`Quick add ${card.title}`}
            className="bg-surface-raised/90 hover:bg-surface-raised absolute bottom-2 right-2 z-10 flex size-10 items-center justify-center rounded-full opacity-100 shadow-sm transition-opacity disabled:opacity-60 lg:opacity-0 lg:group-focus-within:opacity-100 lg:group-hover:opacity-100"
          >
            <PlusIcon className="size-5" aria-hidden />
          </button>
        )}
      </div>
      <div className="flex flex-col gap-1">
        {card.brand && <p className="text-text-secondary text-xs">{card.brand}</p>}
        <Heading className="text-sm font-medium">
          {/* The whole card is clickable through this link's ::after. */}
          <Link
            href={`/products/${card.slug}`}
            className="after:absolute after:inset-0 after:content-[''] hover:underline"
          >
            {card.title}
          </Link>
        </Heading>
        <PriceDisplay
          price={card.price}
          compareAt={card.compare_at}
          priceMax={card.price_max}
          size="sm"
        />
        {card.rating && card.rating.count > 0 && (
          <RatingStars average={card.rating.average} count={card.rating.count} />
        )}
      </div>
    </article>
  );
}

export function ProductGrid({
  cards,
  headingLevel = "h3",
}: {
  cards: Card[];
  headingLevel?: "h2" | "h3";
}) {
  return (
    <ul className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
      {cards.map((card, index) => (
        <li key={card.id}>
          <ProductCard card={card} priority={index < 4} headingLevel={headingLevel} />
        </li>
      ))}
    </ul>
  );
}
