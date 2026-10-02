import { UserIcon } from "lucide-react";
import Link from "next/link";

import { CartDrawer } from "@/components/commerce/cart-drawer";
import { MegaNav } from "@/components/shell/mega-nav";
import { MobileNav } from "@/components/shell/mobile-nav";
import { SearchOverlay } from "@/components/shell/search-overlay";
import { ThemeToggle } from "@/components/theme-toggle";
import { getCartCount, getCategoryTree, getSessionUser } from "@/lib/api-server";

/*
 * The storefront header (PLANNING.md 10.1): menu drawer on phones, the
 * category mega-nav on desktop, search, account, the cart drawer, and the
 * theme. Sticky, so search and the cart are always one tap away.
 */
export async function SiteHeader() {
  const [user, cartCount, categories] = await Promise.all([
    getSessionUser(),
    getCartCount(),
    getCategoryTree(),
  ]);
  return (
    <header className="border-border-subtle bg-surface-page/95 supports-[backdrop-filter]:bg-surface-page/80 sticky top-0 z-40 border-b backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-2 px-4">
        <div className="flex items-center gap-1 lg:gap-6">
          <MobileNav categories={categories} />
          <Link href="/" className="px-1 text-lg font-semibold tracking-tight">
            Velo
          </Link>
          <MegaNav categories={categories} />
        </div>
        <div className="flex items-center gap-1">
          <SearchOverlay />
          <Link
            href={user ? "/account" : "/sign-in"}
            className="hover:bg-surface-sunken flex h-11 min-w-11 items-center justify-center gap-2 rounded-md px-3 text-sm"
          >
            <UserIcon className="size-5 shrink-0" aria-hidden />
            {/* Icon-only on phones: a name beside the other icons overflows 375 px. */}
            <span className="sr-only md:not-sr-only md:inline-block md:max-w-32 md:truncate">
              {user ? (user.first_name ?? "Account") : "Sign in"}
            </span>
          </Link>
          <CartDrawer initialCount={cartCount} />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
