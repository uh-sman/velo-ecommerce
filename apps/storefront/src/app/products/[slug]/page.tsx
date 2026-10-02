import type { Schema } from "@velo/api-client";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";

import { ProductGrid } from "@/components/commerce/product-card";
import { ProductBuy } from "@/components/product/buy-box";
import { RecentlyViewed } from "@/components/product/recently-viewed";
import { Reviews } from "@/components/product/reviews";
import { getSessionUser, publicClient } from "@/lib/api-server";

type Product = Schema<"ProductDetail">;

const getProduct = cache(async (slug: string): Promise<Product | null> => {
  try {
    const { data } = await publicClient().GET("/api/v1/products/{slug}", {
      params: { path: { slug } },
      next: { revalidate: 60 },
    });
    return data ?? null;
  } catch {
    return null;
  }
});

async function extras(slug: string) {
  const client = publicClient();
  const [related, reviews, summary] = await Promise.all([
    client
      .GET("/api/v1/products/{slug}/related", {
        params: { path: { slug } },
        next: { revalidate: 300 },
      })
      .then((r) => r.data ?? [])
      .catch(() => []),
    client
      .GET("/api/v1/products/{slug}/reviews", {
        params: { path: { slug }, query: { limit: 5 } },
        next: { revalidate: 60 },
      })
      .then((r) => r.data ?? null)
      .catch(() => null),
    client
      .GET("/api/v1/products/{slug}/reviews/summary", {
        params: { path: { slug } },
        next: { revalidate: 60 },
      })
      .then((r) => r.data ?? null)
      .catch(() => null),
  ]);
  return { related, reviews, summary };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const product = await getProduct((await params).slug);
  if (!product) return {};
  const image = product.media[0];
  return {
    title: product.seo.title,
    ...(product.seo.description ? { description: product.seo.description } : {}),
    alternates: { canonical: `/products/${product.slug}` },
    openGraph: {
      title: product.seo.title,
      ...(product.seo.description ? { description: product.seo.description } : {}),
      ...(image ? { images: [{ url: image.url, alt: image.alt_text ?? product.title }] } : {}),
    },
  };
}

/** schema.org Product with its offers and rating, for rich results (PLANNING.md 10.3). */
function structuredData(product: Product): Record<string, unknown> {
  const prices = product.variants.map((v) => v.price.amount);
  const currency = product.variants[0]?.price.currency ?? "USD";
  const major = (minor: number) => (minor / 100).toFixed(2);
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.title,
    ...(product.description ? { description: product.description } : {}),
    ...(product.brand ? { brand: { "@type": "Brand", name: product.brand } } : {}),
    image: product.media.map((m) => m.url),
    sku: product.variants[0]?.sku,
    offers: {
      "@type": "AggregateOffer",
      priceCurrency: currency,
      lowPrice: major(Math.min(...prices)),
      highPrice: major(Math.max(...prices)),
      offerCount: product.variants.length,
      availability: product.in_stock
        ? "https://schema.org/InStock"
        : "https://schema.org/OutOfStock",
    },
    ...(product.rating && product.rating.count > 0
      ? {
          aggregateRating: {
            "@type": "AggregateRating",
            ratingValue: product.rating.average,
            reviewCount: product.rating.count,
          },
        }
      : {}),
  };
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [product, user] = await Promise.all([getProduct(slug), getSessionUser()]);
  if (!product) notFound();
  const { related, reviews, summary } = await extras(slug);
  const specs = Object.entries(product.attributes).filter(
    ([, value]) => typeof value === "string" || typeof value === "number",
  );
  const first = product.variants[0];
  const prices = product.variants.map((v) => v.price.amount);

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-16 px-4 py-8 pb-28 lg:pb-8">
      <script
        type="application/ld+json"
        // JSON.stringify escapes quotes; "<" is escaped so no string can close the tag.
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(structuredData(product)).replace(/</g, "\\u003c"),
        }}
      />
      {product.breadcrumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="-mb-12">
          <ol className="text-text-secondary flex flex-wrap items-center gap-1 text-sm">
            <li>
              <Link href="/" className="hover:underline">
                Home
              </Link>
            </li>
            {product.breadcrumbs.map((crumb) => (
              <li key={crumb.slug} className="flex items-center gap-1">
                <span aria-hidden>/</span>
                <Link href={`/categories/${crumb.slug}`} className="hover:underline">
                  {crumb.name}
                </Link>
              </li>
            ))}
          </ol>
        </nav>
      )}

      <ProductBuy product={product} />

      <div className="flex max-w-3xl flex-col">
        {product.description && (
          <Accordion title="Description" open>
            <div className="whitespace-pre-line leading-relaxed">{product.description}</div>
          </Accordion>
        )}
        {specs.length > 0 && (
          <Accordion title="Specifications">
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              {specs.map(([name, value]) => (
                <div key={name} className="contents">
                  <dt className="text-text-secondary capitalize">{name.replace(/_/g, " ")}</dt>
                  <dd>{String(value)}</dd>
                </div>
              ))}
            </dl>
          </Accordion>
        )}
        <Accordion title="Shipping and returns">
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
            <li>Free standard shipping on orders over $75; otherwise from $5.99.</li>
            <li>Tracked delivery — the link arrives by email the moment it ships.</li>
            <li>30 days to return it. Print the label from your order page.</li>
          </ul>
        </Accordion>
      </div>

      <Reviews
        slug={product.slug}
        summary={summary}
        first={reviews?.data ?? []}
        nextCursor={reviews?.pagination.next_cursor ?? null}
        signedIn={user !== null}
      />

      {related.length > 0 && (
        <section aria-labelledby="related-heading" className="flex flex-col gap-6">
          <h2 id="related-heading" className="text-2xl font-semibold tracking-tight">
            You might also like
          </h2>
          <ProductGrid cards={related.slice(0, 4)} />
        </section>
      )}

      {first && (
        <RecentlyViewed
          current={{
            id: product.id,
            slug: product.slug,
            title: product.title,
            subtitle: product.subtitle,
            brand: product.brand,
            image: product.media[0] ?? null,
            price: { ...first.price, amount: Math.min(...prices) },
            price_max: { ...first.price, amount: Math.max(...prices) },
            compare_at: first.compare_at,
            rating: product.rating,
            in_stock: product.in_stock,
            published_at: null,
          }}
        />
      )}
    </div>
  );
}

/** Native details/summary: keyboard and screen-reader behaviour for free. */
function Accordion({
  title,
  open = false,
  children,
}: {
  title: string;
  open?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details open={open} className="border-border-subtle group border-b">
      <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between text-lg font-medium">
        <h2>{title}</h2>
        <span aria-hidden className="text-2xl transition-transform group-open:rotate-45">
          +
        </span>
      </summary>
      <div className="text-text-secondary pb-6">{children}</div>
    </details>
  );
}
