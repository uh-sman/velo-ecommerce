import { RotateCcwIcon, ShieldCheckIcon, TruckIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { ProductGrid } from "@/components/commerce/product-card";
import { Button } from "@/components/ui/button";
import { getCollections } from "@/lib/api-server";
import { collectionProducts, newArrivals } from "@/lib/catalog-server";

export const metadata: Metadata = {
  title: { absolute: "Velo — considered goods, honestly priced" },
  description: "New arrivals, collections, free shipping over $75 and 30-day returns.",
};

// Rebuilt at most once a minute; the catalog reads underneath are cached too.
export const revalidate = 60;

/*
 * PAGE-SPECS.md §1.1. Server-rendered from top to bottom: the first paint is
 * the content, not a skeleton. Every section degrades to nothing rather than
 * to an error when the catalog cannot be read — the page still sells.
 */
export default async function HomePage() {
  const [arrivals, collections] = await Promise.all([newArrivals(8), getCollections()]);
  const featured = collections.slice(0, 2);
  const featuredProducts = await Promise.all(featured.map((c) => collectionProducts(c.slug, 4)));

  return (
    <div className="flex flex-col gap-16 pb-8">
      <section
        aria-labelledby="hero-heading"
        className="bg-surface-sunken border-border-subtle border-b"
      >
        <div className="mx-auto flex max-w-7xl flex-col items-start gap-6 px-4 py-20 sm:py-28">
          <p className="text-text-secondary text-sm font-medium uppercase tracking-wide">
            New season
          </p>
          <h1
            id="hero-heading"
            className="max-w-3xl text-balance text-4xl font-semibold tracking-tight"
          >
            Considered goods, honestly priced.
          </h1>
          <p className="text-text-secondary max-w-xl text-lg">
            Every price you see is the price you pay. Free shipping over $75, and 30 days to change
            your mind.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link href="/products">Shop new arrivals</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/collections">Browse collections</Link>
            </Button>
          </div>
        </div>
      </section>

      {arrivals.length > 0 && (
        <section aria-labelledby="arrivals-heading" className="mx-auto w-full max-w-7xl px-4">
          <div className="mb-6 flex items-end justify-between gap-4">
            <h2 id="arrivals-heading" className="text-2xl font-semibold tracking-tight">
              New arrivals
            </h2>
            <Link href="/products" className="text-sm underline underline-offset-4">
              See everything
            </Link>
          </div>
          <ProductGrid cards={arrivals} />
        </section>
      )}

      {featured.map((collection, index) =>
        (featuredProducts[index]?.length ?? 0) > 0 ? (
          <section
            key={collection.id}
            aria-labelledby={`collection-${collection.slug}`}
            className="mx-auto w-full max-w-7xl px-4"
          >
            <div className="mb-6 flex items-end justify-between gap-4">
              <div>
                <h2
                  id={`collection-${collection.slug}`}
                  className="text-2xl font-semibold tracking-tight"
                >
                  {collection.title}
                </h2>
                {collection.description && (
                  <p className="text-text-secondary mt-1 max-w-2xl">{collection.description}</p>
                )}
              </div>
              <Link
                href={`/collections/${collection.slug}`}
                className="shrink-0 text-sm underline underline-offset-4"
              >
                Shop the collection
              </Link>
            </div>
            <ProductGrid cards={featuredProducts[index] ?? []} />
          </section>
        ) : null,
      )}

      <section aria-labelledby="promise-heading" className="mx-auto w-full max-w-7xl px-4">
        <h2 id="promise-heading" className="sr-only">
          Our promise
        </h2>
        <ul className="grid gap-6 sm:grid-cols-3">
          <Pledge
            icon={<TruckIcon className="size-6" aria-hidden />}
            title="Free shipping over $75"
          >
            Tracked delivery, with a link the moment it ships.
          </Pledge>
          <Pledge icon={<RotateCcwIcon className="size-6" aria-hidden />} title="30-day returns">
            Print a label from your order page. Refunds as soon as it arrives.
          </Pledge>
          <Pledge icon={<ShieldCheckIcon className="size-6" aria-hidden />} title="Secure checkout">
            Card details go straight to our payment provider — never to our servers.
          </Pledge>
        </ul>
      </section>
    </div>
  );
}

function Pledge({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="border-border-subtle flex flex-col gap-2 rounded-lg border p-6">
      {icon}
      <h3 className="font-semibold">{title}</h3>
      <p className="text-text-secondary text-sm">{children}</p>
    </li>
  );
}
