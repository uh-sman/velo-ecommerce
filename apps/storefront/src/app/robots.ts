import type { MetadataRoute } from "next";

import { absoluteUrl } from "@/lib/site";

/**
 * Crawl the catalog; stay out of anything private or per-visitor. These pages
 * also carry `noindex`, which is what keeps them out of results — robots.txt
 * only saves the crawl budget. Staging and previews set NEXT_PUBLIC_SITE_NOINDEX=1
 * and are not crawled at all: they must never compete with the store. (The
 * default is indexable, so a production deploy cannot hide the store by
 * forgetting a variable.)
 */
export default function robots(): MetadataRoute.Robots {
  if (process.env["NEXT_PUBLIC_SITE_NOINDEX"] === "1") {
    return { rules: { userAgent: "*", disallow: "/" } };
  }
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/account",
        "/cart",
        "/checkout",
        "/orders",
        "/search",
        "/unsubscribe",
        "/sign-in",
        "/create-account",
        "/forgot-password",
        "/reset-password",
        "/verify-email",
      ],
    },
    sitemap: absoluteUrl("/sitemap.xml"),
  };
}
