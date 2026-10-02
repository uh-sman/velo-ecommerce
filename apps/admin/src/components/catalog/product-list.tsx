"use client";

import type { Schema } from "@velo/api-client";
import { ImageIcon, MoreHorizontalIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useId, useState } from "react";
import { DropdownMenu } from "radix-ui";

import {
  Badge,
  Pager,
  ProductStatusBadge,
  problemMessage,
  runBatch,
  selectClass,
  TableSkeleton,
  useCursorList,
  useDebounced,
  type BatchResult,
  type ProductStatus,
} from "@/components/catalog/shared";
import { FormAlert } from "@/components/forms/fields";
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  formatDate,
  MoneyText,
  td,
  th,
} from "@/components/page";
import { useCan } from "@/components/shell/me-context";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { notify } from "@/components/ui/sonner";
import { callApi } from "@/lib/api-browser";

type Row = Schema<"AdminProductRow">;

const PAGE_SIZE = 50;
const STOREFRONT = process.env["NEXT_PUBLIC_STOREFRONT_URL"] ?? "http://localhost:3000";

type BulkAction = "publish" | "unpublish" | "archive" | "delete";

const BULK: Record<BulkAction, { label: string; verb: string; status?: ProductStatus }> = {
  publish: { label: "Publish", verb: "published", status: "active" },
  unpublish: { label: "Unpublish", verb: "moved to draft", status: "draft" },
  archive: { label: "Archive", verb: "archived", status: "archived" },
  delete: { label: "Delete", verb: "deleted" },
};

async function setStatus(id: string, status: ProductStatus) {
  return callApi((client) =>
    client.PATCH("/api/v1/admin/products/{product_id}", {
      params: { path: { product_id: id } },
      body: { status },
    }),
  );
}

async function deleteProduct(id: string) {
  return callApi((client) =>
    client.DELETE("/api/v1/admin/products/{product_id}", {
      params: { path: { product_id: id } },
    }),
  );
}

/*
 * PAGE-SPECS.md §3.2. Search and the status filter go to the API (Postgres,
 * so a product saved a moment ago is found at once); 50 rows a page on the
 * API's cursor. Bulk actions run per product and report every failure by
 * name, with a retry for just those.
 */
export function ProductList() {
  const canWrite = useCan("catalog:write");
  const searchId = useId();
  const statusId = useId();
  const [search, setSearch] = useState("");
  const [status, setStatusFilter] = useState<ProductStatus | "">("");
  const query = useDebounced(search.trim());

  const fetchPage = useCallback(
    (cursor: string | null) =>
      callApi((client) =>
        client.GET("/api/v1/admin/products", {
          params: {
            query: {
              limit: PAGE_SIZE,
              ...(cursor ? { cursor } : {}),
              ...(query ? { q: query } : {}),
              ...(status ? { status } : {}),
            },
          },
        }),
      ),
    [query, status],
  );
  const list = useCursorList(fetchPage);
  const { state, setRows } = list;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<BulkAction | null>(null);
  const [report, setReport] = useState<{
    action: BulkAction;
    results: BatchResult<Row>[];
  } | null>(null);
  const [deleting, setDeleting] = useState<Row | null>(null);

  // A new page or new filters: the old selection no longer points at visible rows.
  useEffect(() => {
    setSelected(new Set());
  }, [fetchPage, list.page]);

  const rows = state.phase === "ready" ? state.rows : [];
  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.id));

  const apply = async (action: BulkAction, targets: Row[]): Promise<string | null> => {
    const results = await runBatch(targets, async (row) => {
      const target = BULK[action].status;
      const outcome = target ? await setStatus(row.id, target) : await deleteProduct(row.id);
      return outcome.ok ? null : problemMessage(outcome.problem);
    });
    const done = new Set(results.filter((r) => r.error === null).map((r) => r.item.id));
    const target = BULK[action].status;
    setRows((current) =>
      target
        ? current.map((row) => (done.has(row.id) ? { ...row, status: target } : row))
        : current.filter((row) => !done.has(row.id)),
    );
    const failed = results.filter((r) => r.error !== null);
    setSelected(new Set(failed.map((r) => r.item.id)));
    setReport({ action, results });
    const summary = `${String(done.size)} ${BULK[action].verb}${
      failed.length ? `, ${String(failed.length)} failed` : ""
    }`;
    if (failed.length) notify.warning(summary);
    else notify.success(summary);
    return null;
  };

  /** One product, from the row menu: optimistic, rolled back if the API refuses. */
  const archiveOne = async (row: Row) => {
    setRows((current) => current.map((r) => (r.id === row.id ? { ...r, status: "archived" } : r)));
    const outcome = await setStatus(row.id, "archived");
    if (outcome.ok) {
      notify.success(`“${row.title}” archived`);
    } else {
      setRows((current) => current.map((r) => (r.id === row.id ? row : r)));
      notify.error(`Could not archive “${row.title}”: ${problemMessage(outcome.problem)}`);
    }
  };

  const filtersActive = Boolean(query || status);
  const selectedRows = rows.filter((row) => selected.has(row.id));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-56 flex-1 flex-col gap-1.5">
          <label htmlFor={searchId} className="text-sm font-medium">
            Search
          </label>
          <div className="relative">
            <SearchIcon
              className="text-text-tertiary pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2"
              aria-hidden
            />
            <Input
              id={searchId}
              type="search"
              className="pl-9"
              placeholder="Title, slug or SKU"
              value={search}
              maxLength={100}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={statusId} className="text-sm font-medium">
            Status
          </label>
          <select
            id={statusId}
            className={selectClass}
            value={status}
            onChange={(event) => {
              setStatusFilter(event.target.value as ProductStatus | "");
            }}
          >
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="draft">Draft</option>
            <option value="archived">Archived</option>
          </select>
        </div>
      </div>

      {canWrite && selected.size > 0 && (
        <div
          role="region"
          aria-label="Bulk actions"
          className="border-border-default bg-surface-sunken flex flex-wrap items-center gap-2 rounded-lg border p-3"
        >
          <p className="mr-2 text-sm font-medium">{selected.size} selected</p>
          {(Object.keys(BULK) as BulkAction[]).map((action) => (
            <Button
              key={action}
              size="sm"
              variant={action === "delete" ? "danger" : "outline"}
              onClick={() => {
                setPending(action);
              }}
            >
              {BULK[action].label}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setSelected(new Set());
            }}
          >
            Clear selection
          </Button>
        </div>
      )}

      {report && report.results.some((r) => r.error) && (
        <BulkReport
          report={report}
          onDismiss={() => {
            setReport(null);
          }}
          onRetry={(failed) => apply(report.action, failed)}
        />
      )}

      {state.phase === "loading" && <TableSkeleton label="Loading products" />}
      {state.phase === "error" && (
        <ErrorState
          title={`We could not load products. ${problemMessage(state.problem)}`}
          onRetry={list.reload}
        />
      )}
      {state.phase === "ready" && rows.length === 0 && (
        <EmptyState title={filtersActive ? "No products match" : "No products yet"}>
          {filtersActive ? (
            <Button
              variant="link"
              className="h-auto p-0"
              onClick={() => {
                setSearch("");
                setStatusFilter("");
              }}
            >
              Clear the filters
            </Button>
          ) : (
            canWrite && (
              <div className="mt-2 flex flex-wrap justify-center gap-2">
                <Button asChild>
                  <Link href="/products/new">Add your first product</Link>
                </Button>
                <Button asChild variant="outline">
                  <Link href="/products/import">Import CSV</Link>
                </Button>
              </div>
            )
          )}
        </EmptyState>
      )}

      {state.phase === "ready" && rows.length > 0 && (
        <div aria-busy={state.refreshing} className={state.refreshing ? "opacity-60" : undefined}>
          <div className="border-border-subtle overflow-x-auto rounded-lg border">
            <table aria-label="Products" className="w-full min-w-[48rem] text-left text-sm">
              <thead>
                <tr>
                  {canWrite && (
                    <th className={`${th} w-12`}>
                      <Checkbox
                        aria-label="Select all products on this page"
                        className="size-5"
                        checked={allSelected}
                        onCheckedChange={(checked) => {
                          setSelected(
                            checked === true ? new Set(rows.map((r) => r.id)) : new Set(),
                          );
                        }}
                      />
                    </th>
                  )}
                  <th className={`${th} w-16`}>
                    <span className="sr-only">Image</span>
                  </th>
                  <th className={th}>Product</th>
                  <th className={th}>Status</th>
                  <th className={th}>Stock</th>
                  <th className={`${th} text-right`}>Price</th>
                  <th className={th}>Updated</th>
                  <th className={`${th} w-14`}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="hover:bg-surface-sunken/60">
                    {canWrite && (
                      <td className={td}>
                        <Checkbox
                          aria-label={`Select ${row.title}`}
                          className="size-5"
                          checked={selected.has(row.id)}
                          onCheckedChange={(checked) => {
                            setSelected((current) => {
                              const next = new Set(current);
                              if (checked === true) next.add(row.id);
                              else next.delete(row.id);
                              return next;
                            });
                          }}
                        />
                      </td>
                    )}
                    <td className={td}>
                      <Thumb image={row.image} />
                    </td>
                    <td className={td}>
                      <Link
                        href={`/products/${row.id}`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {row.title}
                      </Link>
                      <p className="text-text-tertiary text-xs">
                        {row.slug}
                        {row.brand ? ` · ${row.brand}` : ""}
                      </p>
                    </td>
                    <td className={td}>
                      <ProductStatusBadge status={row.status} />
                    </td>
                    <td className={td}>
                      {row.in_stock ? (
                        <Badge tone="success">In stock</Badge>
                      ) : (
                        <Badge tone="danger">Out of stock</Badge>
                      )}
                    </td>
                    <td className={`${td} text-right`}>
                      <MoneyText money={row.price} />
                    </td>
                    <td className={`${td} text-text-secondary whitespace-nowrap`}>
                      {formatDate(row.updated_at)}
                    </td>
                    <td className={td}>
                      <RowMenu
                        row={row}
                        canWrite={canWrite}
                        onArchive={() => void archiveOne(row)}
                        onDelete={() => {
                          setDeleting(row);
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager
            page={list.page}
            pageSize={PAGE_SIZE}
            shown={rows.length}
            total={state.pagination.total_count}
            hasPrevious={list.hasPrevious}
            hasNext={list.hasNext}
            onPrevious={list.previous}
            onNext={list.next}
            noun="products"
          />
        </div>
      )}

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={pending ? `${BULK[pending].label} ${String(selectedRows.length)} products?` : ""}
        description={
          pending === "delete"
            ? "Deleted products disappear from the store and this list. Past orders keep their lines."
            : pending === "publish"
              ? "Products without a variant cannot be published; they will be listed as failures."
              : "Each product is updated on its own; any that fail are listed afterwards."
        }
        confirmLabel={pending ? BULK[pending].label : "Confirm"}
        tone={pending === "delete" ? "danger" : "primary"}
        onConfirm={() => (pending ? apply(pending, selectedRows) : Promise.resolve(null))}
      >
        <ul className="text-text-secondary max-h-40 overflow-y-auto text-sm">
          {selectedRows.map((row) => (
            <li key={row.id}>{row.title}</li>
          ))}
        </ul>
      </ConfirmDialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={deleting ? `Delete “${deleting.title}”?` : ""}
        description="It disappears from the store and this list. Past orders keep their lines."
        confirmLabel="Delete product"
        tone="danger"
        onConfirm={async () => {
          if (!deleting) return null;
          const outcome = await deleteProduct(deleting.id);
          if (!outcome.ok) return problemMessage(outcome.problem);
          const gone = deleting.id;
          setRows((current) => current.filter((row) => row.id !== gone));
          notify.success(`“${deleting.title}” deleted`);
          return null;
        }}
      />
    </div>
  );
}

function Thumb({ image }: { image: Schema<"MediaView"> | null }) {
  if (!image) {
    return (
      <span className="bg-surface-sunken text-text-tertiary flex size-10 items-center justify-center rounded-md">
        <ImageIcon className="size-4" aria-hidden />
      </span>
    );
  }
  const small = image.renditions.find((r) => r.width <= 320) ?? null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- storage URLs are not in next/image's allowlist
    <img
      src={small?.url ?? image.url}
      alt=""
      width={40}
      height={40}
      loading="lazy"
      className="bg-surface-sunken size-10 rounded-md object-cover"
    />
  );
}

function RowMenu({
  row,
  canWrite,
  onArchive,
  onDelete,
}: {
  row: Row;
  canWrite: boolean;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const item =
    "hover:bg-accent focus:bg-accent flex min-h-11 cursor-default items-center rounded-sm px-3 text-sm outline-none";
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" size="sm" aria-label={`Actions for ${row.title}`}>
          <MoreHorizontalIcon aria-hidden />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          className="bg-surface-raised border-border-default z-50 min-w-44 rounded-md border p-1 shadow-md"
        >
          <DropdownMenu.Item asChild className={item}>
            <Link href={`/products/${row.id}`}>Edit</Link>
          </DropdownMenu.Item>
          {row.status === "active" && (
            <DropdownMenu.Item asChild className={item}>
              <a href={`${STOREFRONT}/products/${row.slug}`} target="_blank" rel="noreferrer">
                View in store
              </a>
            </DropdownMenu.Item>
          )}
          {canWrite && row.status !== "archived" && (
            <DropdownMenu.Item className={item} onSelect={onArchive}>
              Archive
            </DropdownMenu.Item>
          )}
          {canWrite && (
            <DropdownMenu.Item className={`${item} text-danger`} onSelect={onDelete}>
              Delete…
            </DropdownMenu.Item>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function BulkReport({
  report,
  onDismiss,
  onRetry,
}: {
  report: { action: BulkAction; results: BatchResult<Row>[] };
  onDismiss: () => void;
  onRetry: (failed: Row[]) => Promise<string | null>;
}) {
  const [retrying, setRetrying] = useState(false);
  const failed = report.results.filter((r) => r.error !== null);
  const succeeded = report.results.length - failed.length;
  return (
    <FormAlert
      title={`${String(succeeded)} ${BULK[report.action].verb}, ${String(failed.length)} failed`}
    >
      <ul className="mt-1 flex flex-col gap-1">
        {failed.map((result) => (
          <li key={result.item.id}>
            <Link href={`/products/${result.item.id}`} className="font-medium underline">
              {result.item.title}
            </Link>
            : {result.error}
          </li>
        ))}
      </ul>
      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          loading={retrying}
          onClick={() => {
            setRetrying(true);
            void onRetry(failed.map((r) => r.item)).finally(() => {
              setRetrying(false);
            });
          }}
        >
          Retry {failed.length} failed
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </FormAlert>
  );
}
