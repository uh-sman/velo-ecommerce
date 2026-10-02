"use client";

import { ChevronRightIcon, MenuIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import type { CategoryNode } from "@/lib/api-server";

/** Phones and tablets: the whole navigation in a drawer from the left. */
export function MobileNav({ categories }: { categories: CategoryNode[] }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Navigating closes the drawer.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        className="hover:bg-accent flex size-11 items-center justify-center rounded-md lg:hidden"
        aria-label="Open menu"
      >
        <MenuIcon className="size-5" aria-hidden />
      </SheetTrigger>
      <SheetContent side="left" className="w-80 overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Menu</SheetTitle>
        </SheetHeader>
        <nav aria-label="Main" className="flex flex-col px-4 pb-6">
          <NavLink href="/products">New arrivals</NavLink>
          {categories.map((category) => (
            <details key={category.id} className="group">
              <summary className="flex h-12 cursor-pointer list-none items-center justify-between border-b text-base font-medium">
                {category.name}
                <ChevronRightIcon
                  className="size-4 transition-transform group-open:rotate-90"
                  aria-hidden
                />
              </summary>
              <div className="flex flex-col py-2 pl-4">
                <NavLink href={`/categories/${category.slug}`}>All {category.name}</NavLink>
                {category.children.map((child) => (
                  <NavLink key={child.id} href={`/categories/${child.slug}`}>
                    {child.name}
                  </NavLink>
                ))}
              </div>
            </details>
          ))}
          <NavLink href="/collections">Collections</NavLink>
          <NavLink href="/account">Your account</NavLink>
        </nav>
      </SheetContent>
    </Sheet>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="flex min-h-11 items-center border-b text-base hover:underline">
      {children}
    </Link>
  );
}
