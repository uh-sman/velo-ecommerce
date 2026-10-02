import type { Metadata, Viewport } from "next";
import { WishlistProvider } from "@/components/commerce/wishlist-context";
import { SiteFooter } from "@/components/shell/site-footer";
import { SiteHeader } from "@/components/site-header";
import { ThemeScript } from "@/components/theme-script";
import { Toaster } from "@/components/ui/sonner";
import { getSessionUser } from "@/lib/api-server";
import { fontVariables } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Velo",
    template: "%s · Velo",
  },
  description: "A store that is correct about money and pleasant to use on a phone.",
};

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
