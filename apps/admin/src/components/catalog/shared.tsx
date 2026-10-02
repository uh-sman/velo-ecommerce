"use client";

import {
  createApiClient,
  isProblemDetail,
  type ProblemDetail,
  type Schema,
} from "@velo/api-client";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CSRF_COOKIE, readCookie, refreshSession, type Outcome } from "@/lib/api-browser";
import { apiUrl, cn } from "@/lib/utils";

/*
 * Pieces every catalog page shares: badges in the catalog's own vocabulary,
 * a cursor-paginated list hook, the pager under each table, a raw fetch for
 * the bodies the typed client cannot send (CSV), and a small batch runner
 * for bulk actions that must report per-item outcomes.
 */

// ── Badges ────────────────────────────────────────────────────────────────

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

/** A badge always carries a word; the colour only reinforces it (DESIGN-SYSTEM.md §4). */
export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-sm px-2 py-0.5 text-xs font-medium",
        tone === "neutral" && "bg-surface-sunken text-text-secondary",
        tone === "info" && "bg-info/10 text-info",
        tone === "success" && "bg-success/10 text-success",
        tone === "warning" && "bg-warning/10 text-warning",
        tone === "danger" && "bg-danger/10 text-danger",
        className,
      )}
    >
      {children}
    </span>
  );
}

export const PRODUCT_STATUSES = ["draft", "active", "archived"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

const PRODUCT_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "neutral" },
  active: { label: "Active", tone: "success" },
  archived: { label: "Archived", tone: "warning" },
};

export function productStatusLabel(status: string): string {
  return PRODUCT_STATUS[status]?.label ?? status;
}

export function ProductStatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={PRODUCT_STATUS[status]?.tone ?? "neutral"}>{productStatusLabel(status)}</Badge>
  );
}

/** Stock for one variant: the number only matters at or below the reorder point. */
export function StockBadge({ stock }: { stock: Schema<"StockView"> }) {
  if (!stock.track_inventory) return <Badge>Not tracked</Badge>;
  if (stock.available <= 0) {
    return <Badge tone="danger">{stock.allow_backorder ? "Backorder" : "Out of stock"}</Badge>;
  }
  if (stock.available <= stock.reorder_point) return <Badge tone="warning">Low stock</Badge>;
  return <Badge tone="success">In stock</Badge>;
}

// ── Problems ──────────────────────────────────────────────────────────────

/** The sentence to show for a failed call: the API's detail, else its title. */
export function problemMessage(problem: ProblemDetail): string {
  return problem.detail ?? problem.title;
}

// ── Raw calls (CSV, downloads) ────────────────────────────────────────────

async function csrf(): Promise<string> {
  const existing = readCookie(CSRF_COOKIE);
  if (existing) return existing;
  const { data } = await createApiClient().GET("/api/v1/auth/csrf");
  return data?.csrf_token ?? readCookie(CSRF_COOKIE) ?? "";
}

/**
 * `fetch` against the API for bodies the typed client cannot express — a raw
 * CSV upload, a file download — with the same CSRF header and the same one
 * silent refresh on 401 as `callApi`.
 */
export async function rawApi(path: string, init: RequestInit = {}): Promise<Response> {
  const send = async () => {
    const headers = new Headers(init.headers);
    headers.set("X-CSRF-Token", await csrf());
    return fetch(apiUrl(path), { ...init, headers, credentials: "include" });
  };
  let response = await send();
  if (response.status === 401 && (await refreshSession())) response = await send();
  return response;
}

const NETWORK_PROBLEM: ProblemDetail = {
  type: "https://velo.dev/errors/network",
  title: "We could not reach the store",
  status: 0,
  detail: "Check your connection and try again.",
};

/** A failed response as a problem, whatever the body turned out to be. */
export async function problemOf(response: Response | null): Promise<ProblemDetail> {
  if (!response) return NETWORK_PROBLEM;
  try {
    const body: unknown = await response.json();
    if (isProblemDetail(body)) return body;
  } catch {
    // not JSON — fall through
  }
  return {
    type: `https://velo.dev/errors/http-${String(response.status)}`,
    title: "Something went wrong",
    status: response.status,
    detail: "Please try again.",
  };
}

/** Hand the browser a blob as a file download. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}

/** The catalog as the import format, downloaded. Null on success, else a message. */
export async function downloadCatalogExport(): Promise<string | null> {
  let response: Response;
  try {
    response = await rawApi("/api/v1/admin/products/export");
  } catch {
    return problemMessage(NETWORK_PROBLEM);
  }
  if (!response.ok) return problemMessage(await problemOf(response));
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "velo-catalog.csv";
  saveBlob(await response.blob(), filename);
  return null;
}

// ── Bulk ──────────────────────────────────────────────────────────────────

export interface BatchResult<T> {
  item: T;
  error: string | null;
}

/**
 * Run `work` over every item, a few at a time, and report each outcome. A
 * bulk action that reports only "done" is one nobody trusts twice
 * (PAGE-SPECS.md §3.2).
 */
export async function runBatch<T>(
  items: readonly T[],
  work: (item: T) => Promise<string | null>,
  concurrency = 4,
): Promise<BatchResult<T>[]> {
  const results: BatchResult<T>[] = new Array<BatchResult<T>>(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index] as T;
      try {
        results[index] = { item, error: await work(item) };
      } catch {
        results[index] = { item, error: problemMessage(NETWORK_PROBLEM) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
  return results;
}

// ── Cursor lists ──────────────────────────────────────────────────────────

interface Page<T> {
  data: T[];
  pagination: Schema<"PaginationInfo">;
}

export type ListState<T> =
  | { phase: "loading" }
  | { phase: "error"; problem: ProblemDetail }
  | { phase: "ready"; rows: T[]; pagination: Schema<"PaginationInfo">; refreshing: boolean };

/**
 * A server-paginated list. `fetchPage` is memoised by the caller over its
 * filters; when it changes the list goes back to the first page. Previous
 * pages are a stack of the cursors that led to them.
 */
export function useCursorList<T>(fetchPage: (cursor: string | null) => Promise<Outcome<Page<T>>>) {
  const [nav, setNav] = useState({ source: fetchPage, cursors: [null] as (string | null)[] });
  const cursors = nav.source === fetchPage ? nav.cursors : [null];
  const cursor = cursors[cursors.length - 1] ?? null;
  const [state, setState] = useState<ListState<T>>({ phase: "loading" });
  const [reloads, setReloads] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    const request = ++latest.current;
    setState((current) =>
      current.phase === "ready" ? { ...current, refreshing: true } : { phase: "loading" },
    );
    void fetchPage(cursor).then((outcome) => {
      if (request !== latest.current) return; // a newer request superseded this one
      setState(
        outcome.ok
          ? {
              phase: "ready",
              rows: outcome.data.data,
              pagination: outcome.data.pagination,
              refreshing: false,
            }
          : { phase: "error", problem: outcome.problem },
      );
    });
  }, [fetchPage, cursor, reloads]);

  const reload = useCallback(() => {
    setReloads((count) => count + 1);
  }, []);

  const setRows = useCallback((update: (rows: T[]) => T[]) => {
    setState((current) =>
      current.phase === "ready" ? { ...current, rows: update(current.rows) } : current,
    );
  }, []);

  const next = () => {
    if (state.phase !== "ready" || !state.pagination.next_cursor) return;
    setNav({ source: fetchPage, cursors: [...cursors, state.pagination.next_cursor] });
  };
  const previous = () => {
    if (cursors.length > 1) setNav({ source: fetchPage, cursors: cursors.slice(0, -1) });
  };

  return {
    state,
    reload,
    setRows,
    next,
    previous,
    page: cursors.length,
    hasPrevious: cursors.length > 1,
    hasNext: state.phase === "ready" && state.pagination.has_more,
  };
}

/** Previous / next under a cursor-paginated table, with the position in words. */
export function Pager({
  page,
  pageSize,
  shown,
  total,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  noun,
}: {
  page: number;
  pageSize: number;
  shown: number;
  total: number | null | undefined;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  noun: string;
}) {
  const first = (page - 1) * pageSize + 1;
  const last = first + shown - 1;
  return (
    <nav
      aria-label="Pagination"
      className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm"
    >
      <p className="text-text-secondary" aria-live="polite">
        {shown === 0
          ? `No ${noun}`
          : `${String(first)}–${String(last)}${
              typeof total === "number" ? ` of ${String(total)}` : ""
            } ${noun}`}
      </p>
      <div className="flex gap-2">
        <Button variant="outline" size="md" disabled={!hasPrevious} onClick={onPrevious}>
          <ChevronLeftIcon aria-hidden />
          Previous
        </Button>
        <Button variant="outline" size="md" disabled={!hasNext} onClick={onNext}>
          Next
          <ChevronRightIcon aria-hidden />
        </Button>
      </div>
    </nav>
  );
}

/** Table-shaped loading state at roughly the real dimensions. */
export function TableSkeleton({ rows = 8, label }: { rows?: number; label: string }) {
  return (
    <div className="flex flex-col gap-2" aria-busy aria-label={label} role="status">
      <Skeleton className="h-9 w-full" />
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-12 w-full" />
      ))}
    </div>
  );
}

/** A value that settles `delay` ms after the last change — for search boxes. */
export function useDebounced<T>(value: T, delay = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value);
    }, delay);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delay]);
  return settled;
}

/** A native select styled like the inputs — keyboard and screen-reader friendly by default. */
export const selectClass =
  "border-border-default bg-surface-raised text-text-primary h-10 rounded-md border px-3 text-base outline-none focus-visible:border-border-focus focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:opacity-50 aria-invalid:border-danger";

export const textareaClass =
  "border-border-default bg-surface-raised text-text-primary w-full rounded-md border px-3 py-2 text-base outline-none placeholder:text-text-tertiary focus-visible:border-border-focus focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:border-danger";
