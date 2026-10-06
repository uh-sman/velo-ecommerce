import type { Metadata, Viewport } from "next";
import { WishlistProvider } from "@/components/commerce/wishlist-context";
import { SiteFooter } from "@/components/shell/site-footer";
import { SiteHeader } from "@/components/site-header";
import { JsonLd } from "@/components/seo/json-ld";
import { ThemeScript } from "@/components/theme-script";
import { Toaster } from "@/components/ui/sonner";
import { getSessionUser } from "@/lib/api-server";
import { SITE_DESCRIPTION, SITE_NAME, siteStructuredData, siteUrl } from "@/lib/site";
import { fontVariables } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  // Resolves every relative canonical and Open Graph URL below to the public origin.
  metadataBase: new URL(siteUrl()),
  title: {
    default: SITE_NAME,
    template: `%s · ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    locale: "en_US",
    description: SITE_DESCRIPTION,
  },
  twitter: { card: "summary_large_image" },
  // Staging and previews set NEXT_PUBLIC_SITE_NOINDEX=1 (see robots.ts).
  ...(process.env["NEXT_PUBLIC_SITE_NOINDEX"] === "1" && {
    robots: { index: false, follow: false },
  }),
};

// Every API call goes here, and product images come from the media CDN: start
// both TLS handshakes before the HTML asks for them.
const API_ORIGIN = new URL(process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:8000").origin;
const MEDIA_ORIGIN = process.env["NEXT_PUBLIC_MEDIA_ORIGIN"];

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Never maximumScale: 1 — it blocks pinch-zoom, which is a WCAG failure and
  // the single most common accessibility mistake in a mobile viewport tag.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#020617" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  return (
    <html lang="en" className={fontVariables} suppressHydrationWarning>
      <head>
        <ThemeScript />
        <link rel="preconnect" href={API_ORIGIN} crossOrigin="use-credentials" />
        {MEDIA_ORIGIN && <link rel="preconnect" href={MEDIA_ORIGIN} />}
        <JsonLd data={siteStructuredData()} />
      </head>
      <body className="min-h-dvh antialiased">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <WishlistProvider signedIn={user !== null}>
          <SiteHeader />
          <main id="main" tabIndex={-1} className="outline-none">
            {children}
          </main>
          <SiteFooter />
        </WishlistProvider>
        <Toaster />
      </body>
    </html>
  );
}
