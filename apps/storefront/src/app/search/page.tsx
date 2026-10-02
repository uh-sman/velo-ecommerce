import type { Metadata } from "next";
import Link from "next/link";

import { ProductGrid } from "@/components/commerce/product-card";
import { FormAlert } from "@/components/forms/fields";
import { Button } from "@/components/ui/button";
import { publicClient } from "@/lib/api-server";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 24;
const FACETS = [
  { key: "brand", label: "Brand" },
  { key: "colour", label: "Colour" },
  { key: "size", label: "Size" },
] as const;
type FacetKey = (typeof FACETS)[number]["key"];
type Params = Record<string, string | string[] | undefined>;

function list(value: string | string[] | undefined): string[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Params>;
}): Promise<Metadata> {
  const q = list((await searchParams)["q"])[0] ?? "";
  return { title: q ? `Search: ${q}` : "Search", robots: { index: false } };
}

/*
 * Full search results. Facets are links that toggle a filter in the URL, so
 * they work before JavaScript loads and the back button undoes them. When
 * Meilisearch is down the API answers from Postgres (`degraded`): fewer
 * facets, still results — and the page says so rather than pretending.
 */
export default async function SearchPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const q = (list(params["q"])[0] ?? "").trim();
  const page = Math.max(1, Number.parseInt(list(params["page"])[0] ?? "1", 10) || 1);
  const selected: Record<FacetKey, string[]> = {
    brand: list(params["brand"]),
    colour: list(params["colour"]),
    size: list(params["size"]),
  };

  let results: Awaited<ReturnType<typeof search>> = null;
  if (q) results = await search(q, page, selected);

  function href(changes: Partial<Record<FacetKey, string[]>> & { page?: number }): string {
    const next = new URLSearchParams({ q });
    for (const facet of FACETS) {
      for (const value of changes[facet.key] ?? selected[facet.key]) next.append(facet.key, value);
    }
    if (changes.page && changes.page > 1) next.set("page", String(changes.page));
    return `/search?${next.toString()}`;
  }

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-10">
      <form action="/search" role="search" className="flex max-w-xl gap-2">
        <label htmlFor="search-q" className="sr-only">
          Search products
        </label>
        <input
          id="search-q"
          name="q"
          type="search"
          defaultValue={q}
          placeholder="Search products"
          className="border-border-default bg-surface-raised h-11 flex-1 rounded-md border px-3 text-base"
        />
        <Button type="submit" className="h-11">
          Search
        </Button>
      </form>

      {!q ? (
        <h1 className="text-2xl font-semibold">What are you looking for?</h1>
      ) : !results ? (
        <FormAlert title="Search is not answering right now">
          Please try again in a moment.
        </FormAlert>
      ) : (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">
            {results.total_hits} {results.total_hits === 1 ? "result" : "results"} for “{q}”
          </h1>
          {results.degraded && (
            <p className="text-text-secondary text-sm">
              Search is running in a simpler mode right now, so some filters are unavailable.
            </p>
          )}
          <div className="grid gap-8 lg:grid-cols-[15rem_1fr]">
            <aside aria-label="Filters" className="flex flex-col gap-6">
              {FACETS.map((facet) => {
                const counts = results.facets[facet.key] ?? {};
                const values = Object.keys(counts);
                if (values.length === 0) return null;
                return (
                  <section key={facet.key} aria-labelledby={`facet-${facet.key}`}>
                    <h2 id={`facet-${facet.key}`} className="mb-2 text-sm font-semibold">
                      {facet.label}
                    </h2>
                    <ul className="flex flex-wrap gap-2 lg:flex-col lg:gap-0">
                      {values.map((value) => {
                        const on = selected[facet.key].includes(value);
                        const toggled = on
                          ? selected[facet.key].filter((v) => v !== value)
                          : [...selected[facet.key], value];
                        return (
                          <li key={value}>
                            <Link
                              href={href({ [facet.key]: toggled })}
                              aria-current={on ? "true" : undefined}
                              className={cn(
                                "flex min-h-11 items-center gap-2 rounded-md px-2 text-sm hover:underline",
                                on && "font-semibold",
                              )}
                            >
                              <span
                                aria-hidden
                                className={cn(
                                  "border-border-strong size-4 rounded-sm border",
                                  on && "bg-primary border-primary",
                                )}
                              />
                              {value}
                              <span className="text-text-tertiary">({counts[value]})</span>
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                );
              })}
            </aside>
            <div className="flex flex-col gap-8">
              {results.hits.length === 0 ? (
                <div className="flex flex-col gap-2 py-12 text-center">
                  <p className="font-medium">Nothing matches that search.</p>
                  <p className="text-text-secondary text-sm">
                    Check the spelling, try fewer words, or{" "}
                    <Link href="/products" className="underline">
                      browse everything
                    </Link>
                    .
                  </p>
                </div>
              ) : (
                <ProductGrid cards={results.hits} headingLevel="h2" />
              )}
              <nav aria-label="Pagination" className="flex items-center justify-center gap-3">
                {page > 1 && (
                  <Button asChild variant="outline">
                    <Link href={href({ page: page - 1 })}>Previous</Link>
                  </Button>
                )}
                {page * PAGE_SIZE < results.total_hits && (
                  <Button asChild variant="outline">
                    <Link href={href({ page: page + 1 })}>Next</Link>
                  </Button>
                )}
              </nav>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

async function search(q: string, page: number, selected: Record<FacetKey, string[]>) {
  try {
    const { data } = await publicClient().GET("/api/v1/search", {
      params: {
        query: {
          q,
          limit: PAGE_SIZE,
          offset: (page - 1) * PAGE_SIZE,
          ...(selected.brand.length ? { brand: selected.brand } : {}),
          ...(selected.colour.length ? { colour: selected.colour } : {}),
          ...(selected.size.length ? { size: selected.size } : {}),
        },
      },
      cache: "no-store",
    });
    return data ?? null;
  } catch {
    return null;
  }
}
