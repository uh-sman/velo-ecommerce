"use client";

import type { Schema } from "@velo/api-client";
import { SearchIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import {
  EmptyState,
  ErrorState,
  MoneyText,
  PageHeader,
  Table,
  formatDate,
  td,
  th,
  toMajor,
  toMinor,
} from "@/components/page";
import { useCan } from "@/components/shell/me-context";
import { StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { callApi } from "@/lib/api-browser";
import { cn } from "@/lib/utils";

import { FulfilmentBadge, PaymentBadge } from "./badges";
import { NativeSelect } from "./native-select";
import {
  BUILT_IN_VIEWS,
  FULFILMENT_OPTIONS,
  PAYMENT_OPTIONS,
  STATUS_OPTIONS,
  filtersHref,
  readFilters,
  sameFilters,
  toListQuery,
  type FilterKey,
  type OrderFilters,
} from "./order-filters";
import { SavedViews } from "./saved-views";

type Row = Schema<"AdminOrderSummaryView">;

interface ListState {
  status: "loading" | "ready" | "error";
  rows: Row[];
  next: string | null;
  total: number | null;
  loadingMore: boolean;
  moreError: boolean;
}

const INITIAL: ListState = {
  status: "loading",
  rows: [],
  next: null,
  total: null,
  loadingMore: false,
  moreError: false,
};

/**
 * PAGE-SPECS.md §3.4. Filters live in the URL (so a view can be shared and
 * the back button works); the list re-fetches whenever they change. Payment
 * and fulfilment are separate columns, and a row that needs attention says so
 * in the row itself.
 */
export function OrderList() {
  const canRead = useCan("orders:read");
  const router = useRouter();
  const params = useSearchParams();
  const filters = useMemo(() => readFilters(new URLSearchParams(params.toString())), [params]);
  const key = JSON.stringify(filters);

  const [state, setState] = useState<ListState>(INITIAL);
  const request = useRef(0);

  function apply(next: OrderFilters, replace = false) {
    const href = filtersHref(next);
    if (replace) router.replace(href, { scroll: false });
    else router.push(href, { scroll: false });
  }

  function setFilter(name: FilterKey, value: string, replace = false) {
    const next = { ...filters };
    if (value) next[name] = value;
    else delete next[name];
    apply(next, replace);
  }

  async function fetchPage(cursor: string | null) {
    const id = ++request.current;
    if (cursor) {
      setState((current) => ({ ...current, loadingMore: true, moreError: false }));
    } else {
      setState((current) => ({ ...current, status: "loading" }));
    }
    const outcome = await callApi((client) =>
      client.GET("/api/v1/admin/orders", {
        params: { query: toListQuery(filters, cursor) },
      }),
    );
    if (id !== request.current) return; // a newer filter won the race
    if (!outcome.ok) {
      setState((current) =>
        cursor
          ? { ...current, loadingMore: false, moreError: true }
          : { ...INITIAL, status: "error" },
      );
      return;
    }
    const page = outcome.data;
    setState((current) => ({
      status: "ready",
      rows: cursor ? [...current.rows, ...page.data] : page.data,
      next: page.pagination.has_more ? page.pagination.next_cursor : null,
      total: page.pagination.total_count ?? current.total,
      loadingMore: false,
      moreError: false,
    }));
  }

  useEffect(() => {
    if (canRead) void fetchPage(null);
    // `key` captures every filter; fetchPage reads them from the same render.
  }, [key, canRead]);

  if (!canRead) {
    return (
      <>
        <PageHeader title="Orders" />
        <EmptyState title="You do not have access to orders">
          Ask an owner for the orders permission.
        </EmptyState>
      </>
    );
  }

  const activeView = BUILT_IN_VIEWS.find((view) => sameFilters(view.filters(), filters));
  const filtered = Object.keys(filters).length > 0;

  return (
    <>
      <PageHeader
        title="Orders"
        description={
          state.total !== null
            ? `${state.total.toLocaleString()} ${state.total === 1 ? "order" : "orders"}${
                activeView ? ` · ${activeView.name}` : filtered ? " match these filters" : ""
              }`
            : "Find, ship and refund orders."
        }
        actions={
          <SavedViews
            current={filters}
            onApply={(next) => {
              apply(next);
            }}
          />
        }
      />

      <nav aria-label="Quick views" className="mb-4 flex flex-wrap gap-2">
        {BUILT_IN_VIEWS.map((view) => {
          const active = activeView?.id === view.id;
          return (
            <Link
              key={view.id}
              href={filtersHref(view.filters())}
              scroll={false}
              aria-current={active ? "page" : undefined}
              className={cn(
                "focus-visible:ring-ring/50 inline-flex min-h-11 items-center rounded-full border px-4 text-sm outline-none focus-visible:ring-[3px]",
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border-default hover:bg-accent",
              )}
            >
              {view.name}
            </Link>
          );
        })}
      </nav>

      <FilterBar filters={filters} setFilter={setFilter} />

      <div className="mt-4" aria-live="polite" aria-busy={state.status === "loading"}>
        {state.status === "loading" && <ListSkeleton />}
        {state.status === "error" && (
          <ErrorState
            title="We could not load orders."
            onRetry={() => {
              void fetchPage(null);
            }}
          />
        )}
        {state.status === "ready" && state.rows.length === 0 && (
          <EmptyState title={filtered ? "No orders match these filters" : "No orders yet"}>
            {filtered ? (
              <Link href={filtersHref({})} className="underline underline-offset-4">
                Show all orders
              </Link>
            ) : (
              "Orders appear here the moment a customer checks out."
            )}
          </EmptyState>
        )}
        {state.status === "ready" && state.rows.length > 0 && (
          <>
            <OrderTable rows={state.rows} />
            <div className="mt-4 flex flex-col items-center gap-2">
              <p className="text-text-secondary text-sm">
                Showing {state.rows.length.toLocaleString()}
                {state.total !== null && ` of ${state.total.toLocaleString()}`}
              </p>
              {state.moreError && (
                <p role="alert" className="text-danger text-sm">
                  Could not load more orders.
                </p>
              )}
              {state.next && (
                <Button
                  variant="outline"
                  loading={state.loadingMore}
                  onClick={() => {
                    void fetchPage(state.next);
                  }}
                >
                  {state.moreError ? "Try again" : "Load more"}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}

/** Keeps an input's draft while it has focus; follows the URL otherwise. */
function useDraft(value: string) {
  const ref = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    if (document.activeElement !== ref.current) setDraft(value);
  }, [value]);
  return [draft, setDraft, ref] as const;
}

function FilterBar({
  filters,
  setFilter,
}: {
  filters: OrderFilters;
  setFilter: (name: FilterKey, value: string, replace?: boolean) => void;
}) {
  const [query, setQuery, queryRef] = useDraft(filters.q ?? "");
  const [min, setMin, minRef] = useDraft(toMajor(numberOrNull(filters.min_total)));
  const [max, setMax, maxRef] = useDraft(toMajor(numberOrNull(filters.max_total)));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Typing searches after a pause; it replaces history rather than adding to it.
  function search(value: string) {
    setQuery(value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setFilter("q", value.trim(), true);
    }, 350);
  }

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function commitAmount(name: "min_total" | "max_total", major: string) {
    const minor = major.trim() ? toMinor(major) : null;
    const value = minor === null ? "" : String(minor);
    if (value !== (filters[name] ?? "")) setFilter(name, value);
  }

  return (
    <form
      role="search"
      aria-label="Filter orders"
      onSubmit={(event) => {
        event.preventDefault();
        if (timer.current) clearTimeout(timer.current);
        setFilter("q", query.trim());
      }}
      className="border-border-subtle bg-surface-raised grid grid-cols-1 gap-3 rounded-lg border p-3 sm:grid-cols-2 lg:grid-cols-4"
    >
      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <label htmlFor="order-search" className="text-sm font-medium">
          Search
        </label>
        <div className="relative">
          <SearchIcon
            className="text-text-tertiary pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2"
            aria-hidden
          />
          <Input
            id="order-search"
            ref={queryRef}
            type="search"
            value={query}
            placeholder="Order number, email or SKU"
            className="pl-9"
            onChange={(event) => {
              search(event.target.value);
            }}
          />
        </div>
      </div>
      <NativeSelect
        label="Status"
        options={STATUS_OPTIONS}
        value={filters.status ?? ""}
        onChange={(event) => {
          setFilter("status", event.target.value);
        }}
      />
      <NativeSelect
        label="Payment"
        options={PAYMENT_OPTIONS}
        value={filters.payment_status ?? ""}
        onChange={(event) => {
          setFilter("payment_status", event.target.value);
        }}
      />
      <NativeSelect
        label="Fulfilment"
        options={FULFILMENT_OPTIONS}
        value={filters.fulfilment_status ?? ""}
        onChange={(event) => {
          setFilter("fulfilment_status", event.target.value);
        }}
      />
      <div className="grid grid-cols-2 gap-2">
        <DateInput
          label="Placed from"
          value={filters.placed_from ?? ""}
          max={filters.placed_to}
          onChange={(value) => {
            setFilter("placed_from", value);
          }}
        />
        <DateInput
          label="Placed to"
          value={filters.placed_to ?? ""}
          min={filters.placed_from}
          onChange={(value) => {
            setFilter("placed_to", value);
          }}
        />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:col-span-2 lg:col-span-1">
        <AmountInput
          label="Min total"
          inputRef={minRef}
          value={min}
          onChange={setMin}
          onCommit={() => {
            commitAmount("min_total", min);
          }}
        />
        <AmountInput
          label="Max total"
          inputRef={maxRef}
          value={max}
          onChange={setMax}
          onCommit={() => {
            commitAmount("max_total", max);
          }}
        />
      </div>
      {Object.keys(filters).length > 0 && (
        <div className="flex items-end">
          <Button asChild variant="ghost">
            <Link href={filtersHref({})} scroll={false}>
              <XIcon aria-hidden />
              Clear filters
            </Link>
          </Button>
        </div>
      )}
      {/* Enter in the search box submits; the button is for those who look for one. */}
      <button type="submit" className="sr-only">
        Search
      </button>
    </form>
  );
}

function numberOrNull(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function DateInput({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: string;
  min?: string | undefined;
  max?: string | undefined;
  onChange: (value: string) => void;
}) {
  const id = `filter-${label.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <Input
        id={id}
        type="date"
        value={value}
        className="px-2 text-sm"
        {...(min ? { min } : {})}
        {...(max ? { max } : {})}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </div>
  );
}

function AmountInput({
  label,
  value,
  inputRef,
  onChange,
  onCommit,
}: {
  label: string;
  value: string;
  inputRef: RefObject<HTMLInputElement | null>;
  onChange: (value: string) => void;
  onCommit: () => void;
}) {
  const id = `filter-${label.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <Input
        id={id}
        ref={inputRef}
        inputMode="decimal"
        value={value}
        placeholder="0.00"
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onBlur={onCommit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onCommit();
          }
        }}
      />
    </div>
  );
}

function OrderTable({ rows }: { rows: Row[] }) {
  return (
    <Table label="Orders">
      <thead>
        <tr>
          <th scope="col" className={th}>
            Order
          </th>
          <th scope="col" className={th}>
            Date
          </th>
          <th scope="col" className={th}>
            Customer
          </th>
          <th scope="col" className={cn(th, "text-right")}>
            Total
          </th>
          <th scope="col" className={th}>
            Payment
          </th>
          <th scope="col" className={th}>
            Fulfilment
          </th>
          <th scope="col" className={th}>
            Status
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.id}
            className={cn("hover:bg-accent/50", row.needs_attention && "bg-warning/5")}
          >
            <td className={td}>
              <span className="flex items-center gap-1.5">
                {row.needs_attention && (
                  <TriangleAlertIcon
                    className="text-warning size-4 shrink-0"
                    aria-label="Needs attention"
                    role="img"
                  />
                )}
                <Link
                  href={`/orders/${row.id}`}
                  className="text-primary inline-flex min-h-11 items-center font-mono font-medium underline-offset-4 hover:underline"
                >
                  {row.number}
                </Link>
              </span>
            </td>
            <td className={cn(td, "whitespace-nowrap")}>
              <time dateTime={row.placed_at}>{formatDate(row.placed_at)}</time>
            </td>
            <td className={td}>
              <span className="block max-w-[16rem] truncate">{row.customer_name ?? row.email}</span>
              {row.customer_name && (
                <span className="text-text-secondary block max-w-[16rem] truncate text-xs">
                  {row.email}
                </span>
              )}
            </td>
            <td className={cn(td, "whitespace-nowrap text-right")}>
              <MoneyText money={row.total} />
              <span className="text-text-secondary block text-xs">
                {row.item_count} {row.item_count === 1 ? "item" : "items"}
              </span>
            </td>
            <td className={td}>
              <PaymentBadge status={row.payment_status} />
            </td>
            <td className={td}>
              <FulfilmentBadge status={row.fulfilment_status} />
            </td>
            <td className={td}>
              <StatusBadge status={row.status} />
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function ListSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-label="Loading orders">
      {Array.from({ length: 8 }, (_, index) => (
        <Skeleton key={index} className="h-14 w-full" />
      ))}
    </div>
  );
}
