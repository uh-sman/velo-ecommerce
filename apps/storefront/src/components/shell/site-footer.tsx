import Link from "next/link";

import { getCategoryTree } from "@/lib/api-server";

export async function SiteFooter() {
  const categories = await getCategoryTree();
  return (
    <footer className="border-border-subtle bg-surface-sunken mt-16 border-t">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-12 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-2">
          <p className="text-lg font-semibold">Velo</p>
          <p className="text-text-secondary text-sm">Correct about money, pleasant on a phone.</p>
        </div>
        <nav aria-label="Shop" className="flex flex-col gap-2 text-sm">
          <p className="font-medium">Shop</p>
          <Link href="/products" className="text-text-secondary hover:underline">
            New arrivals
          </Link>
          {categories.slice(0, 5).map((category) => (
            <Link
              key={category.id}
              href={`/categories/${category.slug}`}
              className="text-text-secondary hover:underline"
            >
              {category.name}
            </Link>
          ))}
          <Link href="/collections" className="text-text-secondary hover:underline">
            Collections
          </Link>
        </nav>
        <nav aria-label="Help" className="flex flex-col gap-2 text-sm">
          <p className="font-medium">Help</p>
          <Link href="/orders/lookup" className="text-text-secondary hover:underline">
            Track an order
          </Link>
          <Link href="/help/shipping" className="text-text-secondary hover:underline">
            Shipping
          </Link>
          <Link href="/help/returns" className="text-text-secondary hover:underline">
            Returns — 30 days
          </Link>
          <a href="mailto:support@velo.dev" className="text-text-secondary hover:underline">
            support@velo.dev
          </a>
        </nav>
        <nav aria-label="Account" className="flex flex-col gap-2 text-sm">
          <p className="font-medium">Account</p>
          <Link href="/account" className="text-text-secondary hover:underline">
            Your account
          </Link>
          <Link href="/account/orders" className="text-text-secondary hover:underline">
            Orders
          </Link>
          <Link href="/account/wishlist" className="text-text-secondary hover:underline">
            Wishlist
          </Link>
        </nav>
      </div>
      <div className="border-border-subtle text-text-tertiary border-t py-4 text-center text-xs">
        © {new Date().getFullYear()} Velo. Card payments are processed by our payment providers;
        card details never reach our servers.
      </div>
    </footer>
  );
}
