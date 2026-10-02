"use client";

import type { Schema } from "@velo/api-client";
import { SlidersHorizontalIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { ProductGrid } from "@/components/commerce/product-card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { callApi } from "@/lib/api-browser";
import {
  activeFilterCount,
  apiQuery,
  SORTS,
  toSearch,
  type ListingState,
  type Sort,
} from "@/lib/listing";

type Card = Schema<"ProductCard">;

export interface ListingScope {
  category?: string;
  collection?: string;
}

/*
 * A product listing (PAGE-SPECS.md §1.2): the filter sidebar on desktop, a
 * filter sheet on phones, a sort control, and "Load more". The first page is
 * server-rendered; more pages append in place. Without JavaScript the "Load
 * more" link still works — it is a real link to the next page.
 */
export function Listing({
  scope,
  state,
  cards,
  nextCursor,
  brands,
  total,
}: {
  scope: ListingScope;
  state: ListingState;
  cards: Card[];
  nextCursor: string | null;
  brands: string[];
  total?: number | null | undefined;
}) {
  const [shown, setShown] = useState(cards);
  const [cursor, setCursor] = useState(nextCursor);
  const [loading, setLoading] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const firstNew = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setShown(cards);
    setCursor(nextCursor);
  }, [cards, nextCursor]);

  async function loadMore() {
    if (!cursor) return;
    setLoading(true);
    const outcome = await callApi((client) =>
      client.GET("/api/v1/products", {
        params: { query: { ...apiQuery({ ...state, cursor }), ...scope } },
      }),
    );
    setLoading(false);
    if (!outcome.ok) {
      setAnnouncement("More products could not be loaded. Try again.");
      return;
    }
    const before = shown.length;
    setShown((current) => [...current, ...outcome.data.data]);
    setCursor(outcome.data.pagination.next_cursor ?? null);
    setAnnouncement(`${String(outcome.data.data.length)} more products loaded.`);
    // Focus the first new product, so a keyboard user carries on from there.
    requestAnimationFrame(() => {
      const link = firstNew.current?.querySelectorAll("article a")[before];
      if (link instanceof HTMLElement) link.focus();
    });
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[15rem_1fr]">
      <aside className="hidden lg:block" aria-label="Filters">
        <Filters state={state} brands={brands} />
      </aside>
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-text-secondary text-sm" aria-live="polite">
            {total != null ? `${String(total)} products` : `${String(shown.length)} shown`}
          </p>
          <div className="flex items-center gap-2">
            <MobileFilters state={state} brands={brands} />
            <SortControl state={state} />
          </div>
        </div>
        {shown.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <p className="font-medium">No products match these filters</p>
            <Button asChild variant="outline">
              <Link href="?">Clear all filters</Link>
            </Button>
          </div>
        ) : (
          <div ref={firstNew}>
            <ProductGrid cards={shown} />
          </div>
        )}
        <p className="sr-only" aria-live="polite">
          {announcement}
        </p>
        {cursor && (
          <div className="flex justify-center">
            <Button asChild variant="outline" size="lg" loading={loading}>
              <Link
                href={toSearch({ ...state, cursor })}
                scroll={false}
                onClick={(event) => {
                  event.preventDefault();
                  void loadMore();
                }}
              >
                Load more
              </Link>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function useNavigate() {
  const router = useRouter();
  const pathname = usePathname();
  return (state: ListingState) => {
    router.push(`${pathname}${toSearch({ ...state, cursor: null })}`, { scroll: false });
  };
}

function SortControl({ state }: { state: ListingState }) {
  const navigate = useNavigate();
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-sm">
        Sort
      </label>
      <select
        id={id}
        value={state.sort}
        onChange={(event) => {
          navigate({ ...state, sort: event.target.value as Sort });
        }}
        className="border-border-default bg-surface-raised h-11 rounded-md border px-3 text-sm"
      >
        {SORTS.map((sort) => (
          <option key={sort.value} value={sort.value}>
            {sort.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function MobileFilters({ state, brands }: { state: ListingState; brands: string[] }) {
  const [open, setOpen] = useState(false);
  const count = activeFilterCount(state);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" className="h-11 lg:hidden">
          <SlidersHorizontalIcon aria-hidden />
          Filters{count ? ` (${String(count)})` : ""}
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-80 overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Filters</SheetTitle>
        </SheetHeader>
        <div className="px-4 pb-6">
          <Filters
            state={state}
            brands={brands}
            onApplied={() => {
              setOpen(false);
            }}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Filters({
  state,
  brands,
  onApplied,
}: {
  state: ListingState;
  brands: string[];
  onApplied?: () => void;
}) {
  const navigate = useNavigate();
  const [min, setMin] = useState(state.min?.toString() ?? "");
  const [max, setMax] = useState(state.max?.toString() ?? "");
  const minId = useId();
  const maxId = useId();
  // Filters renders twice (sidebar and phone sheet), so every id must be unique per instance.
  const idPrefix = useId();
  const inStockId = `${idPrefix}-in-stock`;

  useEffect(() => {
    setMin(state.min?.toString() ?? "");
    setMax(state.max?.toString() ?? "");
  }, [state.min, state.max]);

  function apply(next: ListingState) {
    navigate(next);
    onApplied?.();
  }

  function applyPrice(event: FormEvent) {
    event.preventDefault();
    const low = min ? Number.parseFloat(min) : null;
    const high = max ? Number.parseFloat(max) : null;
    apply({
      ...state,
      min: low !== null && Number.isFinite(low) ? low : null,
      max: high !== null && Number.isFinite(high) ? high : null,
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-semibold">Availability</legend>
        <label htmlFor={inStockId} className="flex min-h-11 items-center gap-3 text-sm">
          <Checkbox
            id={inStockId}
            checked={state.inStock}
            onCheckedChange={(checked) => {
              apply({ ...state, inStock: checked === true });
            }}
          />
          In stock only
        </label>
      </fieldset>

      <form onSubmit={applyPrice} className="flex flex-col gap-2">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-semibold">Price</legend>
          <div className="flex items-center gap-2">
            <label htmlFor={minId} className="sr-only">
              Minimum price
            </label>
            <input
              id={minId}
              inputMode="decimal"
              placeholder="Min"
              value={min}
              onChange={(event) => {
                setMin(event.target.value);
              }}
              className="border-border-default bg-surface-raised h-11 w-full rounded-md border px-3 text-base"
            />
            <span aria-hidden>–</span>
            <label htmlFor={maxId} className="sr-only">
              Maximum price
            </label>
            <input
              id={maxId}
              inputMode="decimal"
              placeholder="Max"
              value={max}
              onChange={(event) => {
                setMax(event.target.value);
              }}
              className="border-border-default bg-surface-raised h-11 w-full rounded-md border px-3 text-base"
            />
          </div>
        </fieldset>
        <Button type="submit" variant="outline" size="sm" className="self-start">
          Apply price
        </Button>
      </form>

      {brands.length > 0 && (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-2 text-sm font-semibold">Brand</legend>
          {brands.map((brand) => {
            const id = `${idPrefix}-brand-${brand}`;
            const checked = state.brands.includes(brand);
            return (
              <label key={brand} htmlFor={id} className="flex min-h-11 items-center gap-3 text-sm">
                <Checkbox
                  id={id}
                  checked={checked}
                  onCheckedChange={(value) => {
                    apply({
                      ...state,
                      brands:
                        value === true
                          ? [...state.brands, brand]
                          : state.brands.filter((b) => b !== brand),
                    });
                  }}
                />
                {brand}
              </label>
            );
          })}
        </fieldset>
      )}

      {activeFilterCount(state) > 0 && (
        <Button
          variant="link"
          className="self-start px-0"
          onClick={() => {
            apply({ ...state, brands: [], min: null, max: null, inStock: false });
          }}
        >
          Clear all filters
        </Button>
      )}
    </div>
  );
}
