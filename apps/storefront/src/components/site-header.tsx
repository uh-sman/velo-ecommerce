import { UserIcon } from "lucide-react";
import Link from "next/link";

import { ThemeToggle } from "@/components/theme-toggle";
import { getSessionUser } from "@/lib/api-server";

/** The storefront header. The catalog navigation and cart join it in Phase 10. */
export async function SiteHeader() {
  const user = await getSessionUser();
  return (
    <header className="border-border-subtle border-b">
      <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-4 px-4">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          Velo
        </Link>
        <div className="flex items-center gap-2">
          <Link
            href={user ? "/account" : "/sign-in"}
            className="hover:bg-surface-sunken flex h-11 min-w-11 items-center justify-center gap-2 rounded-md px-3 text-sm"
          >
            <UserIcon className="size-4 shrink-0" aria-hidden />
            {/* Icon-only on phones: a name beside the theme toggle overflows 375 px. */}
            <span className="sr-only sm:not-sr-only sm:inline-block sm:max-w-40 sm:truncate">
              {user ? (user.first_name ?? "Account") : "Sign in"}
            </span>
          </Link>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
