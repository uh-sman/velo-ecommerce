import type { Metadata } from "next";

import { Listing } from "@/components/commerce/listing";
import { FormAlert } from "@/components/forms/fields";
import { brandOptions, loadListing } from "@/lib/catalog-server";
import { readListing } from "@/lib/listing";

export const metadata: Metadata = {
  title: "New arrivals",
  description: "Everything in the store, newest first.",
  alternates: { canonical: "/products" },
};

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const state = readListing(await searchParams);
  const [listing, brands] = await Promise.all([loadListing({}, state), brandOptions({})]);

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-10">
      <h1 className="text-3xl font-semibold tracking-tight">New arrivals</h1>
      {listing.failed ? (
        <FormAlert title="We could not load products right now">
          Please refresh in a moment.
        </FormAlert>
      ) : (
        <Listing
          scope={{}}
          state={state}
          cards={listing.cards}
          nextCursor={listing.nextCursor}
          brands={brands}
        />
      )}
    </div>
  );
}
