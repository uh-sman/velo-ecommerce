"use client";

import type { Schema } from "@velo/api-client";
import { HistoryIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { Fragment, useCallback, useEffect, useId, useState, type FormEvent } from "react";

import {
  Pager,
  problemMessage,
  selectClass,
  StockBadge,
  TableSkeleton,
  useCursorList,
  useDebounced,
} from "@/components/catalog/shared";
import { FieldError, FormAlert, TextField } from "@/components/forms/fields";
import { EmptyState, ErrorState, formatDateTime, td, th } from "@/components/page";
import { useCan } from "@/components/shell/me-context";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ui/sonner";
import { callApi, fieldErrors } from "@/lib/api-browser";
import { cn } from "@/lib/utils";

type StockRow = Schema<"StockRowView">;
type Movement = Schema<"MovementView">;
type Reason = Schema<"AdjustRequest">["reason"];

const PAGE_SIZE = 50;

/** Which way each reason moves stock. The API enforces the same rule. */
const REASONS: { value: Reason; label: string; direction: 1 | -1 | 0 }[] = [
  { value: "restock", label: "Restock — received from a supplier", direction: 1 },
  { value: "return", label: "Return — back on the shelf", direction: 1 },
  { value: "damage", label: "Damage — written off", direction: -1 },
  { value: "theft", label: "Theft or loss", direction: -1 },
  { value: "adjustment", label: "Adjustment — a count correction", direction: 0 },
];

const MOVEMENT_LABEL: Record<string, string> = {
  restock: "Restock",
  return: "Return",
  damage: "Damage",
  theft: "Theft",
  adjustment: "Adjustment",
};

function movementLabel(reason: string): string {
  const label = MOVEMENT_LABEL[reason] ?? reason.replace(/_/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function signed(n: number): string {
  return n > 0 ? `+${String(n)}` : String(n);
}

function withStock(row: StockRow, stock: Schema<"StockView">): StockRow {
  return {
    ...row,
    stock,
    low_stock: stock.track_inventory && stock.available <= stock.reorder_point,
  };
}

/*
 * Stock across every variant (API-SPEC.md "Inventory"). Every change needs a
 * reason — untraceable adjustments are how ledgers stop reconciling — so the
 * adjustment opens inline under its row, and each variant's ledger is one
 * click away.
 */
export function InventoryTable({
  initialQuery = "",
  initialLowStock = false,
}: {
  initialQuery?: string;
  initialLowStock?: boolean;
}) {
  const canAdjust = useCan("inventory:write");
  const searchId = useId();
  const [search, setSearch] = useState(initialQuery);
  const [lowStock, setLowStock] = useState(initialLowStock);
  const query = useDebounced(search.trim());
  const [open, setOpen] = useState<string | null>(null);
  const [history, setHistory] = useState<StockRow | null>(null);

  const fetchPage = useCallback(
    (cursor: string | null) =>
      callApi((client) =>
        client.GET("/api/v1/admin/inventory", {
          params: {
            query: {
              limit: PAGE_SIZE,
              low_stock: lowStock,
              ...(cursor ? { cursor } : {}),
              ...(query ? { q: query } : {}),
            },
          },
        }),
      ),
    [query, lowStock],
  );
  const list = useCursorList(fetchPage);
  const { state, setRows } = list;
  const rows = state.phase === "ready" ? state.rows : [];

  const replace = (variantId: string, update: (row: StockRow) => StockRow) => {
    setRows((current) => current.map((row) => (row.variant_id === variantId ? update(row) : row)));
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4">
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
              placeholder="SKU or product title"
              value={search}
              maxLength={100}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
            />
          </div>
        </div>
        <div className="flex min-h-11 items-center gap-2">
          <Checkbox
            id={`${searchId}-low`}
            className="size-5"
            checked={lowStock}
            onCheckedChange={(checked) => {
              setLowStock(checked === true);
            }}
          />
          <label htmlFor={`${searchId}-low`} className="text-sm font-medium">
            Low stock only
          </label>
        </div>
      </div>

      {state.phase === "loading" && <TableSkeleton label="Loading stock levels" />}
      {state.phase === "error" && (
        <ErrorState
          title={`We could not load stock levels. ${problemMessage(state.problem)}`}
          onRetry={list.reload}
        />
      )}
      {state.phase === "ready" && rows.length === 0 && (
        <EmptyState
          title={
            query || lowStock ? "Nothing matches" : "No variants yet — stock appears with products"
          }
        >
          {(query || lowStock) && (
            <Button
              variant="link"
              className="h-auto p-0"
              onClick={() => {
                setSearch("");
                setLowStock(false);
              }}
            >
              Clear the filters
            </Button>
          )}
        </EmptyState>
      )}

      {state.phase === "ready" && rows.length > 0 && (
        <div aria-busy={state.refreshing} className={state.refreshing ? "opacity-60" : undefined}>
          <div className="border-border-subtle overflow-x-auto rounded-lg border">
            <table aria-label="Stock levels" className="w-full min-w-[56rem] text-left text-sm">
              <thead>
                <tr>
                  <th className={th}>Product</th>
                  <th className={th}>SKU</th>
                  <th className={`${th} text-right`}>On hand</th>
                  <th className={`${th} text-right`}>Reserved</th>
                  <th className={`${th} text-right`}>Available</th>
                  <th className={`${th} text-right`}>Reorder at</th>
                  <th className={th}>Status</th>
                  <th className={th}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <Fragment key={row.variant_id}>
                    <tr>
                      <td className={td}>
                        <Link
                          href={`/products/${row.product_id}`}
                          className="font-medium underline-offset-4 hover:underline"
                        >
                          {row.product_title}
                        </Link>
                        <p className="text-text-tertiary text-xs">{row.variant_title}</p>
                      </td>
                      <td className={`${td} font-mono text-xs`}>{row.sku}</td>
                      <td className={`${td} text-right tabular-nums`}>
                        {row.stock.quantity_on_hand}
                      </td>
                      <td className={`${td} text-right tabular-nums`}>
                        {row.stock.quantity_reserved}
                      </td>
                      <td
                        className={cn(
                          td,
                          "text-right font-medium tabular-nums",
                          row.low_stock && "text-warning",
                          row.stock.available <= 0 && row.stock.track_inventory && "text-danger",
                        )}
                      >
                        {row.stock.available}
                      </td>
                      <td className={`${td} text-right tabular-nums`}>{row.stock.reorder_point}</td>
                      <td className={td}>
                        <StockBadge stock={row.stock} />
                      </td>
                      <td className={`${td} whitespace-nowrap`}>
                        <div className="flex justify-end gap-1">
                          {canAdjust && (
                            <Button
                              size="sm"
                              variant={open === row.variant_id ? "secondary" : "outline"}
                              aria-expanded={open === row.variant_id}
                              aria-controls={`adjust-${row.variant_id}`}
                              onClick={() => {
                                setOpen(open === row.variant_id ? null : row.variant_id);
                              }}
                            >
                              Adjust
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Stock history for ${row.sku}`}
                            onClick={() => {
                              setHistory(row);
                            }}
                          >
                            <HistoryIcon aria-hidden />
                            History
                          </Button>
                        </div>
                      </td>
                    </tr>
                    {open === row.variant_id && (
                      <tr id={`adjust-${row.variant_id}`}>
                        <td
                          colSpan={8}
                          className="border-border-subtle bg-surface-sunken/50 border-t p-4"
                        >
                          <AdjustPanel
                            row={row}
                            onOptimistic={(stock) => {
                              replace(row.variant_id, (r) => withStock(r, stock));
                            }}
                            onRollback={() => {
                              replace(row.variant_id, () => row);
                            }}
                            onSaved={(stock) => {
                              replace(row.variant_id, (r) => withStock(r, stock));
                            }}
                            onClose={() => {
                              setOpen(null);
                            }}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
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
            noun="variants"
          />
        </div>
      )}

      <MovementSheet
        row={history}
        onClose={() => {
          setHistory(null);
        }}
      />
    </div>
  );
}

function AdjustPanel({
  row,
  onOptimistic,
  onRollback,
  onSaved,
  onClose,
}: {
  row: StockRow;
  onOptimistic: (stock: Schema<"StockView">) => void;
  onRollback: () => void;
  onSaved: (stock: Schema<"StockView">) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [reason, setReason] = useState<Reason>("restock");
  const [direction, setDirection] = useState<1 | -1>(1);
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const fixed = REASONS.find((r) => r.value === reason)?.direction ?? 0;
  const sign = fixed === 0 ? direction : fixed;
  const amount = /^\d+$/.test(quantity.trim()) ? Number.parseInt(quantity, 10) : null;
  const delta = amount === null ? null : sign * amount;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    if (delta === null || delta === 0) {
      setErrors({ delta: "Enter a whole number greater than zero." });
      return;
    }
    setErrors({});
    setPending(true);
    const before = row.stock;
    const onHand = before.quantity_on_hand + delta;
    onOptimistic({
      ...before,
      quantity_on_hand: onHand,
      available: onHand - before.quantity_reserved,
    });
    const outcome = await callApi((client) =>
      client.POST("/api/v1/admin/inventory/{variant_id}/adjust", {
        params: { path: { variant_id: row.variant_id } },
        body: { delta, reason, note: note.trim() || null },
      }),
    );
    setPending(false);
    if (outcome.ok) {
      onSaved(outcome.data.stock);
      notify.success(`${row.sku}: ${signed(delta)} (${movementLabel(reason).toLowerCase()})`);
      onClose();
    } else {
      onRollback();
      setErrors(fieldErrors(outcome.problem));
      setProblem(problemMessage(outcome.problem));
    }
  };

  const onHandAfter = delta === null ? null : row.stock.quantity_on_hand + delta;

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <form
        noValidate
        onSubmit={(event) => void submit(event)}
        className="flex flex-1 flex-col gap-4"
        aria-labelledby={`${id}-title`}
      >
        <h3 id={`${id}-title`} className="font-semibold">
          Adjust {row.sku}
        </h3>
        {problem && <FormAlert title={problem} />}
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-reason`} className="text-sm font-medium">
              Reason
            </label>
            <select
              id={`${id}-reason`}
              className={selectClass}
              value={reason}
              aria-invalid={errors["reason"] ? true : undefined}
              onChange={(event) => {
                setReason(event.target.value as Reason);
              }}
            >
              {REASONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <FieldError id={`${id}-reason-error`} message={errors["reason"]} />
          </div>
          {fixed === 0 && (
            <fieldset className="flex flex-col gap-1.5">
              <legend className="text-sm font-medium">Direction</legend>
              <div className="flex gap-4">
                {([1, -1] as const).map((value) => (
                  <label key={value} className="flex min-h-10 items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name={`${id}-direction`}
                      className="accent-primary size-4"
                      checked={direction === value}
                      onChange={() => {
                        setDirection(value);
                      }}
                    />
                    {value === 1 ? "Add" : "Remove"}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <TextField
            label={sign > 0 ? "Quantity to add" : "Quantity to remove"}
            className="w-40"
            inputMode="numeric"
            value={quantity}
            error={errors["delta"]}
            hint={
              onHandAfter === null
                ? `On hand: ${String(row.stock.quantity_on_hand)}`
                : `On hand: ${String(row.stock.quantity_on_hand)} → ${String(onHandAfter)}`
            }
            onChange={(event) => {
              setQuantity(event.target.value);
            }}
          />
        </div>
        <TextField
          label="Note"
          optional
          value={note}
          maxLength={500}
          error={errors["note"]}
          placeholder="PO-1042, cycle count, …"
          onChange={(event) => {
            setNote(event.target.value);
          }}
        />
        <div className="flex gap-2">
          <Button type="submit" loading={pending}>
            Save adjustment
          </Button>
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
        </div>
      </form>
      <ReorderPointForm row={row} onSaved={onSaved} />
    </div>
  );
}

function ReorderPointForm({
  row,
  onSaved,
}: {
  row: StockRow;
  onSaved: (stock: Schema<"StockView">) => void;
}) {
  const [value, setValue] = useState(String(row.stock.reorder_point));
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const unchanged = value.trim() === String(row.stock.reorder_point);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!/^\d+$/.test(value.trim())) {
      setError("A whole number, zero or more.");
      return;
    }
    setError(undefined);
    setPending(true);
    const outcome = await callApi((client) =>
      client.PATCH("/api/v1/admin/inventory/{variant_id}", {
        params: { path: { variant_id: row.variant_id } },
        body: { reorder_point: Number.parseInt(value, 10) },
      }),
    );
    setPending(false);
    if (outcome.ok) {
      onSaved(outcome.data);
      notify.success(`${row.sku}: reorder point ${value.trim()}`);
    } else {
      setError(problemMessage(outcome.problem));
    }
  };

  return (
    <form
      noValidate
      onSubmit={(event) => void submit(event)}
      className="border-border-subtle flex flex-col gap-3 lg:w-64 lg:border-l lg:pl-6"
    >
      <h3 className="font-semibold">Low-stock alert</h3>
      <TextField
        label="Reorder point"
        inputMode="numeric"
        value={value}
        error={error}
        hint="Flagged as low stock at or below this many available."
        onChange={(event) => {
          setValue(event.target.value);
        }}
      />
      <Button type="submit" variant="outline" loading={pending} disabled={unchanged}>
        Save reorder point
      </Button>
    </form>
  );
}

function MovementSheet({ row, onClose }: { row: StockRow | null; onClose: () => void }) {
  const [movements, setMovements] = useState<Movement[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const variantId = row?.variant_id ?? null;

  const load = useCallback(
    async (after: string | null) => {
      if (!variantId) return;
      setFailed(false);
      const outcome = await callApi((client) =>
        client.GET("/api/v1/admin/inventory/{variant_id}/movements", {
          params: {
            path: { variant_id: variantId },
            query: { limit: 50, ...(after ? { cursor: after } : {}) },
          },
        }),
      );
      if (!outcome.ok) {
        setFailed(true);
        return;
      }
      setMovements((current) => [...(after ? (current ?? []) : []), ...outcome.data.data]);
      setCursor(outcome.data.pagination.next_cursor);
    },
    [variantId],
  );

  useEffect(() => {
    setMovements(null);
    setCursor(null);
    void load(null);
  }, [load]);

  return (
    <Sheet
      open={row !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Stock history</SheetTitle>
          <SheetDescription>
            {row ? `${row.product_title} — ${row.variant_title} (${row.sku})` : ""}
          </SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">
          {failed && (
            <ErrorState
              title="We could not load the history."
              onRetry={() => void load(movements?.length ? cursor : null)}
            />
          )}
          {!failed && movements === null && (
            <div
              className="flex flex-col gap-2"
              aria-busy
              role="status"
              aria-label="Loading history"
            >
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton key={index} className="h-14" />
              ))}
            </div>
          )}
          {movements?.length === 0 && <EmptyState title="No movements yet" />}
          {movements && movements.length > 0 && (
            <ol className="flex flex-col">
              {movements.map((movement) => (
                <li
                  key={movement.id}
                  className="border-border-subtle flex items-start justify-between gap-3 border-b py-3"
                >
                  <div className="min-w-0">
                    <p className="font-medium">{movementLabel(movement.reason)}</p>
                    <p className="text-text-secondary text-xs">
                      {formatDateTime(movement.created_at)}
                      {movement.reference_type ? ` · ${movement.reference_type}` : ""}
                      {movement.actor_id ? " · by staff" : ""}
                    </p>
                    {movement.note && (
                      <p className="text-text-secondary mt-1 text-sm">{movement.note}</p>
                    )}
                  </div>
                  <span
                    className={cn(
                      "font-medium tabular-nums",
                      movement.quantity_delta > 0 ? "text-success" : "text-danger",
                    )}
                  >
                    {signed(movement.quantity_delta)}
                  </span>
                </li>
              ))}
            </ol>
          )}
          {cursor && movements && (
            <Button
              variant="outline"
              className="mt-4 w-full"
              loading={loadingMore}
              onClick={() => {
                setLoadingMore(true);
                void load(cursor).finally(() => {
                  setLoadingMore(false);
                });
              }}
            >
              Load older movements
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
