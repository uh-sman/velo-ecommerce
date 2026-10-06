/**
 * The storefront's public identity: where it lives and what it is called.
 *
 * `NEXT_PUBLIC_SITE_URL` is the canonical origin — what search engines index
 * and what social cards link to — so every absolute URL (canonical tags, Open
 * Graph, the sitemap, structured data) is built from it, never from the
 * request's Host header, which a proxy or a preview deployment can change.
 */

export const SITE_NAME = "Velo";
export const SITE_DESCRIPTION =
  "Considered goods, honestly priced. Free shipping over $75 and 30-day returns.";

export function siteUrl(): string {
  return (process.env["NEXT_PUBLIC_SITE_URL"] ?? "http://localhost:3000").replace(/\/+$/, "");
}

/** An absolute URL on this site for a path such as `/products/tote`. */
export function absoluteUrl(path = "/"): string {
  return `${siteUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

export type Crumb = { name: string; path: string };

/** schema.org BreadcrumbList for a trail that starts at Home. */
export function breadcrumbList(trail: Crumb[]): Record<string, unknown> {
  const items = [{ name: "Home", path: "/" }, ...trail];
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((crumb, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: crumb.name,
      item: absoluteUrl(crumb.path),
    })),
  };
}

/** schema.org Organization and WebSite (with the sitelinks search box), site-wide. */
export function siteStructuredData(): Record<string, unknown>[] {
  return [
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: SITE_NAME,
      url: absoluteUrl("/"),
      logo: absoluteUrl("/icon.svg"),
    },
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: SITE_NAME,
      url: absoluteUrl("/"),
      potentialAction: {
        "@type": "SearchAction",
        target: { "@type": "EntryPoint", urlTemplate: `${absoluteUrl("/search")}?q={q}` },
        "query-input": "required name=q",
      },
    },
  ];
}
