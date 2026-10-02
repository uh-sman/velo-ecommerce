"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { SignOutButton } from "@/components/auth/sign-out-button";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/account/orders", label: "Orders" },
  { href: "/account/returns", label: "Returns" },
  { href: "/account/wishlist", label: "Wishlist" },
  { href: "/account", label: "Details" },
  { href: "/account/addresses", label: "Addresses" },
  { href: "/account/sessions", label: "Sessions" },
];

/*
 * PAGE-SPECS.md Part 2: a sidebar at lg and up, a horizontally scrolling tab
 * bar on mobile; the active item carries aria-current="page".
 */
export function AccountNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Account" className="lg:w-48 lg:shrink-0">
      <ul className="-mx-4 flex gap-1 overflow-x-auto px-4 lg:mx-0 lg:flex-col lg:px-0">
        {LINKS.map((link) => {
          const current =
            link.href === "/account" ? pathname === link.href : pathname.startsWith(link.href);
          return (
            <li key={link.href} className="shrink-0">
              <Link
                href={link.href}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "flex h-11 items-center rounded-md px-3 text-sm transition-colors",
                  current
                    ? "bg-surface-sunken text-text-primary font-medium"
                    : "text-text-secondary hover:text-text-primary",
                )}
              >
                {link.label}
              </Link>
            </li>
          );
        })}
        <li className="shrink-0 lg:mt-4">
          <SignOutButton
            variant="ghost"
            className="text-text-secondary h-11 w-full justify-start"
          />
        </li>
      </ul>
    </nav>
  );
}
