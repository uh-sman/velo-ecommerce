"use client";

import { ChevronRightIcon, LogOutIcon, MenuIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { CommandPalette } from "@/components/shell/command-palette";
import { useMe } from "@/components/shell/me-context";
import { GROUPS, NAV, sectionOf } from "@/components/shell/nav";
import { ThemeToggle } from "@/components/theme-toggle";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { callApi } from "@/lib/api-browser";
import { can } from "@/lib/permissions";
import { cn } from "@/lib/utils";

/*
 * The admin shell (PLANNING.md 11): a sidebar of what this role may use, a top
 * bar with breadcrumbs, the command palette (⌘K / Ctrl+K), theme, and sign
 * out. Below `lg` the sidebar becomes a drawer.
 */
export function AdminShell({ children }: { children: React.ReactNode }) {
  const me = useMe();
  const pathname = usePathname();
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);

  useEffect(() => {
    setDrawer(false);
  }, [pathname]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const sidebar = <Sidebar permissions={me.permissions} pathname={pathname} />;

  return (
    <div className="flex min-h-dvh">
      <aside className="border-border-subtle bg-surface-sunken hidden w-60 shrink-0 border-r lg:block">
        <div className="sticky top-0 flex h-dvh flex-col">{sidebar}</div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-border-subtle bg-surface-page/95 sticky top-0 z-30 flex h-14 items-center gap-2 border-b px-4 backdrop-blur">
          <Sheet open={drawer} onOpenChange={setDrawer}>
            <SheetTrigger
              className="hover:bg-accent flex size-10 items-center justify-center rounded-md lg:hidden"
              aria-label="Open navigation"
            >
              <MenuIcon className="size-5" aria-hidden />
            </SheetTrigger>
            <SheetContent side="left" className="w-64 p-0">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              {sidebar}
            </SheetContent>
          </Sheet>
          <Breadcrumbs pathname={pathname} />
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                setPalette(true);
              }}
              className="border-border-default text-text-secondary hover:bg-accent hidden h-9 items-center gap-2 rounded-md border px-3 text-sm sm:flex"
              aria-keyshortcuts="Control+K Meta+K"
            >
              <SearchIcon className="size-4" aria-hidden />
              Search or jump to…
              <kbd className="bg-surface-sunken rounded px-1.5 font-mono text-xs">⌘K</kbd>
            </button>
            <button
              type="button"
              onClick={() => {
                setPalette(true);
              }}
              className="hover:bg-accent flex size-10 items-center justify-center rounded-md sm:hidden"
              aria-label="Search or jump to"
            >
              <SearchIcon className="size-5" aria-hidden />
            </button>
            <ThemeToggle />
          </div>
        </header>
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 py-6 outline-none lg:px-8">
          {children}
        </main>
      </div>
      <CommandPalette open={palette} onOpenChange={setPalette} />
    </div>
  );
}

function Sidebar({ permissions, pathname }: { permissions: string[]; pathname: string }) {
  const me = useMe();
  const router = useRouter();
  const current = sectionOf(pathname);
  const visible = NAV.filter((item) => can(permissions, item.permission));

  async function signOut() {
    await callApi((client) => client.POST("/api/v1/auth/logout"), { refreshOnExpiry: false });
    router.replace("/sign-in");
    router.refresh();
  }

  return (
    <nav aria-label="Admin" className="flex h-full flex-col gap-4 overflow-y-auto p-3">
      <Link href="/" className="px-2 py-2 text-lg font-semibold tracking-tight">
        Velo <span className="text-text-secondary font-normal">Admin</span>
      </Link>
      {GROUPS.map((group) => {
        const items = visible.filter((item) => item.group === group);
        if (items.length === 0) return null;
        return (
          <div key={group} className="flex flex-col gap-0.5">
            <p className="text-text-tertiary px-2 pb-1 text-xs font-medium uppercase tracking-wide">
              {group}
            </p>
            {items.map((item) => {
              const active = current?.href === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex h-9 items-center gap-2 rounded-md px-2 text-sm",
                    active
                      ? "bg-surface-raised text-text-primary font-medium shadow-sm"
                      : "text-text-secondary hover:text-text-primary hover:bg-accent",
                  )}
                >
                  <item.icon className="size-4" aria-hidden />
                  {item.label}
                </Link>
              );
            })}
          </div>
        );
      })}
      <div className="border-border-subtle mt-auto flex flex-col gap-1 border-t pt-3">
        <p className="truncate px-2 text-sm font-medium">
          {[me.first_name, me.last_name].filter(Boolean).join(" ") || me.email}
        </p>
        <p className="text-text-secondary px-2 text-xs capitalize">{me.role}</p>
        <button
          type="button"
          onClick={() => void signOut()}
          className="text-text-secondary hover:text-text-primary hover:bg-accent flex h-9 items-center gap-2 rounded-md px-2 text-sm"
        >
          <LogOutIcon className="size-4" aria-hidden />
          Sign out
        </button>
      </div>
    </nav>
  );
}

function Breadcrumbs({ pathname }: { pathname: string }) {
  const section = sectionOf(pathname);
  const rest = section && section.href !== "/" ? pathname.slice(section.href.length) : "";
  const tail = rest.split("/").filter(Boolean);
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="text-text-secondary flex min-w-0 items-center gap-1 text-sm">
        <li className={cn(tail.length === 0 && "text-text-primary font-medium")}>
          {section && tail.length > 0 ? (
            <Link href={section.href} className="hover:underline">
              {section.label}
            </Link>
          ) : (
            <span aria-current="page">{section?.label ?? "Admin"}</span>
          )}
        </li>
        {tail.map((part, index) => (
          <li key={part} className="flex min-w-0 items-center gap-1">
            <ChevronRightIcon className="size-3.5 shrink-0" aria-hidden />
            <span
              className={cn(
                "truncate",
                index === tail.length - 1 && "text-text-primary font-medium",
              )}
              aria-current={index === tail.length - 1 ? "page" : undefined}
            >
              {decodeURIComponent(part).replace(/-/g, " ")}
            </span>
          </li>
        ))}
      </ol>
    </nav>
  );
}
