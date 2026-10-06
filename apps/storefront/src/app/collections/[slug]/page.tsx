import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

import { Listing } from "@/components/commerce/listing";
import { FormAlert } from "@/components/forms/fields";
import { publicClient } from "@/lib/api-server";
import { brandOptions, loadListing } from "@/lib/catalog-server";
import { readListing } from "@/lib/listing";
import { SITE_NAME } from "@/lib/site";

const getCollection = cache(async (slug: string) => {
  const { data } = await publicClient().GET("/api/v1/collections/{slug}", {
    params: { path: { slug } },
    next: { revalidate: 60 },
  });
  return data ?? null;
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const data = await getCollection((await params).slug);
  if (!data) return {};
  const { title, description, slug } = data.collection;
  const canonical = `/collections/${slug}`;
  return {
    title,
    ...(description ? { description } : {}),
    alternates: { canonical },
    openGraph: {
      siteName: SITE_NAME,
      title,
      url: canonical,
      ...(description ? { description } : {}),
    },
  };
}

export default async function CollectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const state = readListing(await searchParams);
  const [collection, listing, brands] = await Promise.all([
    getCollection(slug),
    loadListing({ collection: slug }, state),
    brandOptions({ collection: slug }),
  ]);
  if (!collection) notFound();

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-10">
      <div className="flex max-w-2xl flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{collection.collection.title}</h1>
        {collection.collection.description && (
          <p className="text-text-secondary">{collection.collection.description}</p>
        )}
      </div>
      {listing.failed ? (
        <FormAlert title="We could not load products right now">
          Please refresh in a moment.
        </FormAlert>
      ) : (
        <Listing
          scope={{ collection: slug }}
          state={state}
          cards={listing.cards}
          nextCursor={listing.nextCursor}
          brands={brands}
        />
      )}
    </div>
  );
}
