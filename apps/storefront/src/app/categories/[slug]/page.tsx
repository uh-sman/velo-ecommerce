import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";

import { Listing } from "@/components/commerce/listing";
import { FormAlert } from "@/components/forms/fields";
import { publicClient } from "@/lib/api-server";
import { brandOptions, loadListing } from "@/lib/catalog-server";
import { readListing } from "@/lib/listing";

const getCategory = cache(async (slug: string) => {
  const { data, response } = await publicClient().GET("/api/v1/categories/{slug}", {
    params: { path: { slug }, query: { limit: 1 } },
    next: { revalidate: 60 },
  });
  return { data: data ?? null, status: response.status };
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { data } = await getCategory((await params).slug);
  return data ? { title: data.category.name } : {};
}

export default async function CategoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const state = readListing(await searchParams);
  const [category, listing, brands] = await Promise.all([
    getCategory(slug),
    loadListing({ category: slug }, state),
    brandOptions({ category: slug }),
  ]);
  if (category.status === 404 || !category.data) notFound();
  const { breadcrumbs, children } = category.data;

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-10">
      <nav aria-label="Breadcrumb">
        <ol className="text-text-secondary flex flex-wrap items-center gap-1 text-sm">
          <li>
            <Link href="/" className="hover:underline">
              Home
            </Link>
          </li>
          {breadcrumbs.map((crumb, index) => (
            <li key={crumb.slug} className="flex items-center gap-1">
              <span aria-hidden>/</span>
              {index === breadcrumbs.length - 1 ? (
                <span aria-current="page" className="text-text-primary">
                  {crumb.name}
                </span>
              ) : (
                <Link href={`/categories/${crumb.slug}`} className="hover:underline">
                  {crumb.name}
                </Link>
              )}
            </li>
          ))}
        </ol>
      </nav>
      <h1 className="text-3xl font-semibold tracking-tight">{category.data.category.name}</h1>
      {children.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Subcategories">
          {children.map((child) => (
            <li key={child.id}>
              <Link
                href={`/categories/${child.slug}`}
                className="border-border-default hover:bg-accent flex h-11 items-center rounded-full border px-4 text-sm"
              >
                {child.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {listing.failed ? (
        <FormAlert title="We could not load products right now">
          Please refresh in a moment.
        </FormAlert>
      ) : (
        <Listing
          scope={{ category: slug }}
          state={state}
          cards={listing.cards}
          nextCursor={listing.nextCursor}
          brands={brands}
        />
      )}
    </div>
  );
}
