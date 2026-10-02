"use client";

import { formatMoney, type paths, type Schema } from "@velo/api-client";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { FormAlert } from "@/components/forms/fields";
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  MoneyText,
  PageHeader,
  formatDateTime,
} from "@/components/page";
import { useCan } from "@/components/shell/me-context";
import { StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { notify } from "@/components/ui/sonner";
import { callApi } from "@/lib/api-browser";
import { cn } from "@/lib/utils";

import { ListSkeleton } from "./order-list";
import { previewRefund } from "./order-math";
import { paymentLabel } from "./refund-dialog";
import { ReceiveDialog, RejectDialog } from "./return-dialogs";

type Return = Schema<"ReturnView">;
type Order = Schema<"AdminOrderView">;
type Action = Schema<"UpdateReturn">["action"];
type StatusFilter = NonNullable<
  NonNullable<paths["/api/v1/admin/returns"]["get"]["parameters"]["query"]>["status"]
>;

const STATUS_TABS: { value: StatusFilter | ""; label: string }[] = [
  { value: "", label: "All" },
  { value: "requested", label: "Requested" },
  { value: "approved", label: "Approved" },
  { value: "in_transit", label: "In transit" },
  { value: "received", label: "Received" },
  { value: "refunded", label: "Refunded" },
  { value: "rejected", label: "Rejected" },
  { value: "closed", label: "Closed" },
];

/** What each status allows next (state.py RETURN_ALLOWED, as the admin offers it). */
const NEXT_ACTIONS: Record<string, Action[]> = {
  requested: ["approve", "reject"],
  approved: ["mark_in_transit", "receive", "close"],
  in_transit: ["receive"],
  received: ["refund", "close"],
  refunded: ["close"],
  rejected: ["close"],
  closed: [],
};

const ACTION_LABELS: Record<Action, string> = {
  approve: "Approve",
  reject: "Reject…",
  mark_in_transit: "Mark in transit",
  receive: "Receive…",
  refund: "Refund…",
  close: "Close",
};

const REASONS: Record<string, string> = {
  changed_mind: "Changed their mind",
  wrong_size: "Wrong size or fit",
  not_as_described: "Not as described",
  damaged: "Arrived damaged",
  defective: "Faulty",
  wrong_item: "Wrong item sent",
  other: "Something else",
};

/**
 * Orders by number, resolved on demand. A return carries its order's number
 * but not its id or line titles, so the queue looks the order up when a
 * return is opened, received or refunded — and remembers it.
 */
function useOrders() {
  const [orders, setOrders] = useState<Record<string, Order | "missing">>({});
  const inFlight = useRef(new Map<string, Promise<Order | null>>());

  function resolve(number: string): Promise<Order | null> {
    const known = orders[number];
    if (known) return Promise.resolve(known === "missing" ? null : known);
    const running = inFlight.current.get(number);
    if (running) return running;
    const task = (async () => {
      const list = await callApi((client) =>
        client.GET("/api/v1/admin/orders", { params: { query: { q: number, limit: 5 } } }),
      );
      const match = list.ok ? list.data.data.find((row) => row.number === number) : undefined;
      if (!match) {
        if (list.ok) setOrders((current) => ({ ...current, [number]: "missing" }));
        return null;
      }
      const detail = await callApi((client) =>
        client.GET("/api/v1/admin/orders/{order_id}", {
          params: { path: { order_id: match.id } },
        }),
      );
      if (!detail.ok) return null;
      setOrders((current) => ({ ...current, [number]: detail.data }));
      return detail.data;
    })().finally(() => {
      inFlight.current.delete(number);
    });
    inFlight.current.set(number, task);
    return task;
  }

  function forget(number: string) {
    setOrders((current) => {
      const next = { ...current };
      delete next[number];
      return next;
    });
  }

  return { orders, resolve, forget };
}

export function ReturnsQueue() {
  const canRead = useCan("orders:read");
  const router = useRouter();
  const params = useSearchParams();
  const raw = params.get("status") ?? "";
  const status = STATUS_TABS.some((tab) => tab.value === raw) ? (raw as StatusFilter | "") : "";

  const [rows, setRows] = useState<Return[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [next, setNext] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const request = useRef(0);
  const orders = useOrders();

  async function fetchPage(cursor: string | null) {
    const ticket = ++request.current;
    if (cursor) setLoadingMore(true);
    else setState("loading");
    const outcome = await callApi((client) =>
      client.GET("/api/v1/admin/returns", {
        params: {
          query: { limit: 50, ...(status ? { status } : {}), ...(cursor ? { cursor } : {}) },
        },
      }),
    );
    if (ticket !== request.current) return;
    setLoadingMore(false);
    if (!outcome.ok) {
      if (cursor) notify.error("Could not load more returns.");
      else setState("error");
      return;
    }
    setRows((current) => (cursor ? [...current, ...outcome.data.data] : outcome.data.data));
    setNext(outcome.data.pagination.has_more ? outcome.data.pagination.next_cursor : null);
    setState("ready");
  }

  useEffect(() => {
    if (canRead) void fetchPage(null);
  }, [status, canRead]);

  if (!canRead) {
    return (
      <>
        <PageHeader title="Returns" />
        <EmptyState title="You do not have access to returns">
          Ask an owner for the orders permission.
        </EmptyState>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Returns"
        description="Approve, receive, refund and close what customers send back."
      />
      <nav aria-label="Filter returns by status" className="mb-4 flex flex-wrap gap-2">
        {STATUS_TABS.map((tab) => {
          const active = tab.value === status;
          return (
            <button
              key={tab.value || "all"}
              type="button"
              aria-pressed={active}
              onClick={() => {
                router.push(tab.value ? `/returns?status=${tab.value}` : "/returns", {
                  scroll: false,
                });
              }}
              className={cn(
                "focus-visible:ring-ring/50 inline-flex min-h-11 items-center rounded-full border px-4 text-sm outline-none focus-visible:ring-[3px]",
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border-default hover:bg-accent",
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>

      <div aria-live="polite" aria-busy={state === "loading"}>
        {state === "loading" && <ListSkeleton />}
        {state === "error" && (
          <ErrorState
            title="We could not load returns."
            onRetry={() => {
              void fetchPage(null);
            }}
          />
        )}
        {state === "ready" && rows.length === 0 && (
          <EmptyState title={status ? "No returns with this status" : "No returns yet"}>
            Customers request returns from their order page.
          </EmptyState>
        )}
        {state === "ready" && rows.length > 0 && (
          <ul className="flex flex-col gap-3">
            {rows.map((returned) => (
              <ReturnCard
                key={returned.id}
                returned={returned}
                order={returned.order_number ? orders.orders[returned.order_number] : undefined}
                resolve={orders.resolve}
                onUpdated={(updated) => {
                  setRows((current) =>
                    current.map((row) => (row.id === updated.id ? { ...row, ...updated } : row)),
                  );
                  // Its order moved on too (stock, refunds): look it up afresh next time.
                  if (updated.order_number) orders.forget(updated.order_number);
                }}
              />
            ))}
          </ul>
        )}
        {state === "ready" && next && (
          <div className="mt-4 flex justify-center">
            <Button
              variant="outline"
              loading={loadingMore}
              onClick={() => {
                void fetchPage(next);
              }}
            >
              Load more
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

function ReturnCard({
  returned,
  order,
  resolve,
  onUpdated,
}: {
  returned: Return;
  order: Order | "missing" | undefined;
  resolve: (number: string) => Promise<Order | null>;
  onUpdated: (updated: Return) => void;
}) {
  const canFulfil = useCan("orders:fulfil");
  const canRefund = useCan("orders:refund");
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<Action | null>(null);
  const [dialog, setDialog] = useState<"reject" | "receive" | "refund" | "close" | null>(null);
  const [includeShipping, setIncludeShipping] = useState(false);
  const number = returned.order_number;
  const loaded = order && order !== "missing" ? order : null;

  const actions = (NEXT_ACTIONS[returned.status] ?? []).filter((action) =>
    action === "refund" ? canRefund : canFulfil,
  );

  function ensureOrder() {
    if (number && !order) void resolve(number);
  }

  async function act(
    action: Action,
    extra: Partial<Omit<Schema<"UpdateReturn">, "action">> = {},
  ): Promise<string | null> {
    setBusy(action);
    const outcome = await callApi((client) =>
      client.PATCH("/api/v1/admin/returns/{return_id}", {
        params: { path: { return_id: returned.id } },
        body: { action, include_shipping: false, ...extra },
      }),
    );
    setBusy(null);
    if (!outcome.ok) return outcome.problem.detail ?? outcome.problem.title;
    onUpdated(outcome.data);
    notify.success(`${returned.rma_number}: ${doneLabel(action)}`);
    return null;
  }

  async function quick(action: Action) {
    const failure = await act(action);
    if (failure) notify.error(`${returned.rma_number}: ${failure}`);
  }

  const lineTitle = (id: string) => {
    const line = loaded?.lines.find((entry) => entry.id === id);
    return line
      ? `${line.product_title}${line.variant_title ? ` · ${line.variant_title}` : ""}`
      : "Item";
  };

  const refundEstimate =
    loaded &&
    previewRefund(loaded, {
      lines: returned.lines.map((line) => ({ id: line.order_item_id, quantity: line.quantity })),
      includeShipping,
      extra: 0,
    });

  return (
    <li className="border-border-subtle bg-surface-raised rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            <span className="font-mono">{returned.rma_number}</span>
            <StatusBadge status={returned.status} />
          </p>
          <p className="text-text-secondary mt-1 text-sm">
            {number ? (
              <Link
                href={loaded ? `/orders/${loaded.id}` : `/orders?q=${encodeURIComponent(number)}`}
                className="text-primary font-mono underline underline-offset-4"
              >
                {number}
              </Link>
            ) : (
              "Order"
            )}{" "}
            · {REASONS[returned.reason] ?? returned.reason.replace(/_/g, " ")} · requested{" "}
            {formatDateTime(returned.created_at)}
          </p>
          <p className="text-sm">
            {returned.lines.reduce((sum, line) => sum + line.quantity, 0)} units
            {returned.refund_amount && (
              <>
                {" "}
                · refunded <MoneyText money={returned.refund_amount} />
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {actions.map((action) => (
            <Button
              key={action}
              size="sm"
              variant={action === "reject" || action === "close" ? "outline" : "primary"}
              loading={busy === action}
              disabled={busy !== null}
              onClick={() => {
                if (action === "approve" || action === "mark_in_transit") {
                  void quick(action);
                } else {
                  if (action === "receive" || action === "refund") ensureOrder();
                  setIncludeShipping(false);
                  setDialog(action);
                }
              }}
            >
              {ACTION_LABELS[action]}
            </Button>
          ))}
        </div>
      </div>

      {returned.customer_note && (
        <blockquote className="border-border-default mt-2 border-l-2 pl-3 text-sm">
          <span className="text-text-secondary text-xs">Customer:</span> {returned.customer_note}
        </blockquote>
      )}
      {returned.staff_note && (
        <p className="mt-1 text-sm">
          <span className="text-text-secondary text-xs">Staff note:</span> {returned.staff_note}
        </p>
      )}

      <Button
        variant="ghost"
        size="sm"
        className="-ml-3 mt-2"
        aria-expanded={expanded}
        aria-controls={`return-lines-${returned.id}`}
        onClick={() => {
          if (!expanded) ensureOrder();
          setExpanded((current) => !current);
        }}
      >
        {expanded ? <ChevronUpIcon aria-hidden /> : <ChevronDownIcon aria-hidden />}
        {expanded ? "Hide items" : "Show items"}
      </Button>
      {expanded && (
        <ul id={`return-lines-${returned.id}`} className="mt-1 flex flex-col gap-1 text-sm">
          {order === undefined && number && <li className="text-text-secondary">Loading items…</li>}
          {order === "missing" && (
            <li className="text-text-secondary">The order could not be found.</li>
          )}
          {returned.lines.map((line) => (
            <li key={line.order_item_id}>
              {line.quantity} × {lineTitle(line.order_item_id)}
              {line.condition && <span className="text-text-secondary"> · {line.condition}</span>}
              {line.restock && <span className="text-text-secondary"> · restocked</span>}
            </li>
          ))}
        </ul>
      )}

      {dialog === "reject" && (
        <RejectDialog
          rma={returned.rma_number}
          onClose={() => {
            setDialog(null);
          }}
          onReject={(note) => act("reject", { staff_note: note })}
        />
      )}
      {dialog === "receive" && (
        <ReceiveDialog
          returned={returned}
          lineTitle={lineTitle}
          loading={order === undefined && Boolean(number)}
          onClose={() => {
            setDialog(null);
          }}
          onReceive={(lines, note) =>
            act("receive", { lines, ...(note ? { staff_note: note } : {}) })
          }
        />
      )}
      <ConfirmDialog
        open={dialog === "refund"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        tone="danger"
        title={
          refundEstimate && loaded
            ? `Refund about ${formatMoney({
                amount: refundEstimate.total,
                currency: loaded.currency,
              })} to ${paymentLabel(loaded)}?`
            : `Refund return ${returned.rma_number}?`
        }
        description="Every unit on this return is refunded to the original payment method. This cannot be undone."
        confirmLabel="Refund return"
        onConfirm={() => act("refund", { include_shipping: includeShipping })}
      >
        <label
          htmlFor={`return-shipping-${returned.id}`}
          className="flex min-h-11 cursor-pointer items-center gap-3 text-sm"
        >
          <Checkbox
            id={`return-shipping-${returned.id}`}
            checked={includeShipping}
            onCheckedChange={(checked) => {
              setIncludeShipping(checked === true);
            }}
          />
          Also refund the shipping the customer paid
        </label>
        {refundEstimate?.exceeds && (
          <FormAlert title="This looks like more than is left to refund on the payment." />
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === "close"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title={`Close return ${returned.rma_number}?`}
        description="A closed return leaves the queue and cannot be reopened."
        confirmLabel="Close return"
        onConfirm={() => act("close")}
      />
    </li>
  );
}

function doneLabel(action: Action): string {
  switch (action) {
    case "approve":
      return "approved";
    case "reject":
      return "rejected";
    case "mark_in_transit":
      return "marked in transit";
    case "receive":
      return "received";
    case "refund":
      return "refund issued";
    case "close":
      return "closed";
  }
}
