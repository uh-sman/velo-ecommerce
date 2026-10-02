"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const TABS = [
  { href: "/settings", label: "Store" },
  { href: "/settings/emails", label: "Emails" },
  { href: "/settings/payments", label: "Payments" },
  { href: "/settings/shipping", label: "Shipping" },
  { href: "/settings/tax", label: "Tax" },
] as const;

/** Settings sections as links, so each has its own URL and the back button works. */
export function SettingsTabs() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Settings sections"
      className="border-border-subtle mb-6 overflow-x-auto border-b"
    >
      <ul className="flex min-w-max gap-1">
        {TABS.map((tab) => {
          const current = pathname === tab.href;
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "focus-visible:ring-ring/50 -mb-px inline-flex min-h-11 items-center border-b-2 px-3 text-sm font-medium outline-none focus-visible:ring-[3px]",
                  current
                    ? "border-primary text-text-primary"
                    : "text-text-secondary hover:text-text-primary border-transparent",
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
