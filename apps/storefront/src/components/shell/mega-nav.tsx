"use client";

import { ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import { NavigationMenu } from "radix-ui";

import type { CategoryNode } from "@/lib/api-server";
import { cn } from "@/lib/utils";

/*
 * Desktop category navigation. Radix NavigationMenu gives the keyboard model
 * (arrows between triggers, Escape closes, focus returns) and the ARIA wiring;
 * a panel opens on hover *and* on click or Enter — nothing is hover-only.
 */
export function MegaNav({ categories }: { categories: CategoryNode[] }) {
  if (categories.length === 0) return null;
  return (
    <NavigationMenu.Root className="relative hidden lg:block" aria-label="Shop by category">
      <NavigationMenu.List className="flex items-center gap-1">
        {categories.slice(0, 6).map((category) =>
          category.children.length === 0 ? (
            <NavigationMenu.Item key={category.id}>
              <NavigationMenu.Link asChild>
                <Link
                  href={`/categories/${category.slug}`}
                  className="hover:bg-accent flex h-11 items-center rounded-md px-3 text-sm font-medium"
                >
                  {category.name}
                </Link>
              </NavigationMenu.Link>
            </NavigationMenu.Item>
          ) : (
            <NavigationMenu.Item key={category.id}>
              <NavigationMenu.Trigger className="hover:bg-accent data-[state=open]:bg-accent group flex h-11 items-center gap-1 rounded-md px-3 text-sm font-medium">
                {category.name}
                <ChevronDownIcon
                  className="size-3.5 transition-transform group-data-[state=open]:rotate-180"
                  aria-hidden
                />
              </NavigationMenu.Trigger>
              <NavigationMenu.Content className="bg-surface-raised border-border-subtle absolute left-0 top-full mt-2 w-[min(40rem,90vw)] rounded-lg border p-5 shadow-lg">
                <div className="grid grid-cols-3 gap-6">
                  <div className="flex flex-col gap-2">
                    <NavigationMenu.Link asChild>
                      <Link
                        href={`/categories/${category.slug}`}
                        className="font-semibold hover:underline"
                      >
                        All {category.name}
                      </Link>
                    </NavigationMenu.Link>
                  </div>
                  {category.children.map((child) => (
                    <div key={child.id} className="flex flex-col gap-2">
                      <NavigationMenu.Link asChild>
                        <Link
                          href={`/categories/${child.slug}`}
                          className="font-medium hover:underline"
                        >
                          {child.name}
                        </Link>
                      </NavigationMenu.Link>
                      {child.children.slice(0, 6).map((leaf) => (
                        <NavigationMenu.Link key={leaf.id} asChild>
                          <Link
                            href={`/categories/${leaf.slug}`}
                            className="text-text-secondary hover:text-text-primary text-sm hover:underline"
                          >
                            {leaf.name}
                          </Link>
                        </NavigationMenu.Link>
                      ))}
                    </div>
                  ))}
                </div>
              </NavigationMenu.Content>
            </NavigationMenu.Item>
          ),
        )}
        <NavigationMenu.Item>
          <NavigationMenu.Link asChild>
            <Link
              href="/collections"
              className={cn("hover:bg-accent flex h-11 items-center rounded-md px-3 text-sm")}
            >
              Collections
            </Link>
          </NavigationMenu.Link>
        </NavigationMenu.Item>
      </NavigationMenu.List>
    </NavigationMenu.Root>
  );
}
