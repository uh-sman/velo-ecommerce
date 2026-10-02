"use client";

import { formatMoney, type Schema } from "@velo/api-client";
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  FileTextIcon,
  MailIcon,
  PackageCheckIcon,
  PrinterIcon,
  RotateCcwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import Link from "next/link";
import { DropdownMenu } from "radix-ui";
import { useEffect, useRef, useState } from "react";

import { FormAlert } from "@/components/forms/fields";
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  MoneyText,
  Section,
  Table,
  formatDate,
  formatDateTime,
  td,
  th,
} from "@/components/page";
import { IfCan, useCan } from "@/components/shell/me-context";
import { StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ui/sonner";
import { callApi } from "@/lib/api-browser";
import { apiUrl, cn } from "@/lib/utils";

import { FulfilmentBadge, PaymentBadge, RefundBadge } from "./badges";
import { FulfilDialog, packingSlipUrl } from "./fulfil-dialog";
import {
  CANCELLABLE,
  CAN_SET_DELIVERED,
  CAN_SET_PROCESSING,
  SHIPPABLE,
  addressLines,
  customerName,
  refundLedger,
  unshippedUnits,
} from "./order-math";
import { OrderNotes } from "./order-notes";
import { OrderTimeline } from "./order-timeline";
import { RefundDialog, paymentLabel } from "./refund-dialog";
import { Shipments } from "./shipments";

type Order = Schema<"AdminOrderView">;

type Load =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error"; message: string }
  | { status: "ready"; order: Order };

/**
 * PAGE-SPECS.md §3.5. Loads the order in the browser (so an expired session
 * refreshes silently), then keeps it in local state: endpoints that return
 * the order replace it; the rest (parcels, refunds) reload it quietly.
 */
export function OrderDetail({ id }: { id: string }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const request = useRef(0);

  async function fetchOrder(quiet: boolean) {
    const ticket = ++request.current;
    if (!quiet) setLoad({ status: "loading" });
    const outcome = await callApi((client) =>
      client.GET("/api/v1/admin/orders/{order_id}", { params: { path: { order_id: id } } }),
    );
    if (ticket !== request.current) return;
    if (outcome.ok) {
      setLoad({ status: "ready", order: outcome.data });
    } else if (outcome.problem.status === 404 || outcome.problem.status === 422) {
      setLoad({ status: "missing" });
    } else if (quiet) {
      notify.error("Could not refresh the order. Reload the page to see the latest.");
    } else {
      setLoad({ status: "error", message: outcome.problem.title });
    }
  }

  useEffect(() => {
    void fetchOrder(false);
    // Re-run only when the order changes.
  }, [id]);

  return (
    <div className="flex flex-col gap-4">
      <Link
        href="/orders"
        className="text-text-secondary hover:text-text-primary inline-flex min-h-11 w-fit items-center gap-1 text-sm"
      >
        <ArrowLeftIcon className="size-4" aria-hidden />
        Orders
      </Link>
      {load.status === "loading" && <DetailSkeleton />}
      {load.status === "missing" && (
        <EmptyState title="No such order">
          It may have been typed wrong.{" "}
          <Link href="/orders" className="underline underline-offset-4">
            Back to orders
          </Link>
        </EmptyState>
      )}
      {load.status === "error" && (
        <ErrorState
          title={`We could not load this order. ${load.message}`}
          onRetry={() => {
            void fetchOrder(false);
          }}
        />
      )}
      {load.status === "ready" && (
        <OrderView
          order={load.order}
          setOrder={(order) => {
            setLoad({ status: "ready", order });
          }}
          reload={() => fetchOrder(true)}
        />
      )}
    </div>
  );
}

function OrderView({
  order,
  setOrder,
  reload,
}: {
  order: Order;
  setOrder: (order: Order) => void;
  reload: () => Promise<void>;
}) {
  const canFulfil = useCan("orders:fulfil");
  const canRefund = useCan("orders:refund");
  const [fulfilOpen, setFulfilOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [dialogKey, setDialogKey] = useState(0);
  const [confirm, setConfirm] = useState<"processing" | "delivered" | "cancel" | null>(null);

  const ledger = refundLedger(order);
  const leftToShip = order.lines.reduce((sum, line) => sum + unshippedUnits(line, ledger), 0);
  const dispute = disputeOpen(order);
  const stuckRefunds = order.admin_refunds.filter(
    (refund) =>
      refund.status === "failed" || (refund.status === "pending" && refund.last_error !== null),
  );
  const canShip = SHIPPABLE.has(order.status) && leftToShip > 0 && !dispute;
  const refundable = order.refundable.amount > 0 && order.payment !== null;
  const moreActions = [
    canFulfil && CAN_SET_PROCESSING.has(order.status) ? ("processing" as const) : null,
    canFulfil && CAN_SET_DELIVERED.has(order.status) ? ("delivered" as const) : null,
    canRefund && CANCELLABLE.has(order.status) ? ("cancel" as const) : null,
  ].filter((value) => value !== null);

  async function setStatus(status: "processing" | "delivered"): Promise<string | null> {
    const outcome = await callApi((client) =>
      client.POST("/api/v1/admin/orders/{order_id}/status", {
        params: { path: { order_id: order.id } },
        body: { status },
      }),
    );
    if (!outcome.ok) return outcome.problem.detail ?? outcome.problem.title;
    setOrder(outcome.data);
    notify.success(status === "processing" ? "Marked as preparing" : "Marked as delivered");
    return null;
  }

  async function cancel(): Promise<string | null> {
    const outcome = await callApi((client) =>
      client.POST("/api/v1/admin/orders/{order_id}/cancel", {
        params: { path: { order_id: order.id } },
        body: {},
      }),
    );
    if (!outcome.ok) return outcome.problem.detail ?? outcome.problem.title;
    setOrder(outcome.data);
    notify.success(`Order ${outcome.data.number} cancelled`);
    return null;
  }

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">
            Order <span className="select-all font-mono">{order.number}</span>
          </h1>
          <p className="text-text-secondary mt-1 text-sm">
            Placed {formatDateTime(order.placed_at)}
            {order.cancelled_at && ` · cancelled ${formatDateTime(order.cancelled_at)}`}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <StatusBadge status={order.status} />
            <PaymentBadge status={order.payment_status} />
            <FulfilmentBadge status={order.fulfilment_status} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canFulfil && canShip && (
            <Button
              onClick={() => {
                setDialogKey((key) => key + 1);
                setFulfilOpen(true);
              }}
            >
              <PackageCheckIcon aria-hidden />
              Fulfil items
            </Button>
          )}
          {canRefund && refundable && (
            <Button
              variant="outline"
              onClick={() => {
                setDialogKey((key) => key + 1);
                setRefundOpen(true);
              }}
            >
              <RotateCcwIcon aria-hidden />
              Refund
            </Button>
          )}
          <Button asChild variant="outline">
            <a
              href={apiUrl(`/api/v1/admin/orders/${order.id}/invoice`)}
              target="_blank"
              rel="noopener noreferrer"
            >
              <FileTextIcon aria-hidden />
              Invoice
            </a>
          </Button>
          <Button asChild variant="outline">
            <a href={packingSlipUrl(order.id)} target="_blank" rel="noopener noreferrer">
              <PrinterIcon aria-hidden />
              Packing slip
            </a>
          </Button>
          {moreActions.length > 0 && (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <Button variant="outline">
                  More
                  <ChevronDownIcon aria-hidden />
                </Button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  sideOffset={6}
                  className="border-border-default bg-surface-raised z-50 min-w-48 rounded-md border p-1 shadow-lg"
                >
                  {moreActions.map((action) => (
                    <DropdownMenu.Item
                      key={action}
                      onSelect={() => {
                        setConfirm(action);
                      }}
                      className={cn(
                        "data-[highlighted]:bg-accent flex min-h-11 cursor-pointer items-center rounded-sm px-3 text-sm outline-none",
                        action === "cancel" && "text-danger",
                      )}
                    >
                      {action === "processing"
                        ? "Mark as preparing"
                        : action === "delivered"
                          ? "Mark as delivered"
                          : "Cancel order…"}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )}
        </div>
      </header>

      {dispute && (
        <FormAlert title="This payment is disputed">
          Hold the goods until the dispute closes — fulfilment is blocked meanwhile.
        </FormAlert>
      )}
      {stuckRefunds.length > 0 && (
        <FormAlert
          title={`${String(stuckRefunds.length)} ${
            stuckRefunds.length === 1 ? "refund needs" : "refunds need"
          } attention`}
        >
          See the refund history below. A pending refund with an error is retried automatically
          unless it says it was escalated — then check the provider’s dashboard.
        </FormAlert>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
          <Section title="Items">
            <ItemsTable order={order} />
            <Summary order={order} />
          </Section>
          <Section title="Shipments">
            <Shipments
              order={order}
              onUpdated={() => {
                void reload();
              }}
            />
          </Section>
          {order.admin_refunds.length > 0 && (
            <Section title="Refunds">
              <RefundHistory order={order} />
            </Section>
          )}
          {order.returns.length > 0 && (
            <Section
              title="Returns"
              actions={
                <Link href="/returns" className="text-primary text-sm underline underline-offset-4">
                  Returns queue
                </Link>
              }
            >
              <ul className="flex flex-col gap-2 text-sm">
                {order.returns.map((returned) => (
                  <li key={returned.id} className="flex flex-wrap items-center gap-2">
                    <span className="font-mono">{returned.rma_number}</span>
                    <StatusBadge status={returned.status} />
                    <span className="text-text-secondary">
                      {returned.reason.replace(/_/g, " ")} · {formatDate(returned.created_at)}
                    </span>
                    {returned.refund_amount && (
                      <span>
                        Refunded <MoneyText money={returned.refund_amount} />
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}
          <Section title="Timeline">
            <OrderTimeline order={order} />
          </Section>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Section title="Customer">
            <CustomerCard order={order} />
          </Section>
          <Section title="Payment">
            <PaymentCard order={order} />
          </Section>
          <Section title="Notes">
            <OrderNotes
              order={order}
              onChange={(note) => {
                setOrder({ ...order, internal_note: note });
              }}
              onSaved={setOrder}
            />
          </Section>
        </div>
      </div>

      {canFulfil && (
        <FulfilDialog
          key={`fulfil-${String(dialogKey)}`}
          order={order}
          open={fulfilOpen}
          onOpenChange={setFulfilOpen}
          onFulfilled={() => {
            void reload();
          }}
        />
      )}
      {canRefund && (
        <RefundDialog
          key={`refund-${String(dialogKey)}`}
          order={order}
          open={refundOpen}
          onOpenChange={setRefundOpen}
          onRefunded={() => {
            void reload();
          }}
        />
      )}

      <ConfirmDialog
        open={confirm === "processing" || confirm === "delivered"}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={confirm === "delivered" ? "Mark as delivered?" : "Mark as preparing?"}
        description={
          confirm === "delivered"
            ? "Use this when the carrier did not report the delivery itself."
            : "Tells the customer their order is being prepared."
        }
        confirmLabel={confirm === "delivered" ? "Mark delivered" : "Mark preparing"}
        onConfirm={() => setStatus(confirm === "delivered" ? "delivered" : "processing")}
      />
      <ConfirmDialog
        open={confirm === "cancel"}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        tone="danger"
        title={`Cancel order ${order.number}?`}
        description={
          order.refundable.amount > 0
            ? `Every item goes back into stock and the customer is refunded everything — ${formatMoney(
                order.refundable,
              )} to ${paymentLabel(order)}. This cannot be undone.`
            : "Every item goes back into stock. Nothing was paid, so nothing is refunded. This cannot be undone."
        }
        confirmLabel="Cancel order and refund"
        onConfirm={cancel}
      />
    </>
  );
}

function disputeOpen(order: Order): boolean {
  const dispute = order.metadata["dispute"];
  return (
    typeof dispute === "object" && dispute !== null && "open" in dispute && dispute.open === true
  );
}

function ItemsTable({ order }: { order: Order }) {
  return (
    <Table label="Items">
      <thead>
        <tr>
          <th scope="col" className={th}>
            Item
          </th>
          <th scope="col" className={cn(th, "text-right")}>
            Qty
          </th>
          <th scope="col" className={cn(th, "text-right")}>
            Shipped
          </th>
          <th scope="col" className={cn(th, "text-right")}>
            Returned
          </th>
          <th scope="col" className={cn(th, "text-right")}>
            Refunded
          </th>
          <th scope="col" className={cn(th, "text-right")}>
            Unit price
          </th>
          <th scope="col" className={cn(th, "text-right")}>
            Total
          </th>
        </tr>
      </thead>
      <tbody>
        {order.lines.map((line) => (
          <tr key={line.id}>
            <td className={td}>
              <span className="block font-medium">{line.product_title}</span>
              <span className="text-text-secondary block text-xs">
                {[line.variant_title, line.sku].filter(Boolean).join(" · ")}
              </span>
            </td>
            <td className={cn(td, "text-right tabular-nums")}>{line.quantity}</td>
            <td className={cn(td, "text-right tabular-nums")}>{line.quantity_fulfilled}</td>
            <td className={cn(td, "text-right tabular-nums")}>{line.quantity_returned}</td>
            <td className={cn(td, "text-right tabular-nums")}>{line.quantity_refunded}</td>
            <td className={cn(td, "whitespace-nowrap text-right")}>
              <MoneyText money={line.unit_price} />
            </td>
            <td className={cn(td, "whitespace-nowrap text-right")}>
              <MoneyText money={line.total} />
              {line.discount.amount > 0 && (
                <span className="text-text-secondary block text-xs">
                  incl. −{formatMoney(line.discount)}
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function Summary({ order }: { order: Order }) {
  const { totals } = order;
  return (
    <dl className="ml-auto mt-4 grid max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm tabular-nums">
      <dt className="text-text-secondary">Subtotal</dt>
      <dd className="text-right">
        <MoneyText money={totals.subtotal} />
      </dd>
      {totals.discount.amount > 0 && (
        <>
          <dt className="text-text-secondary">
            Discount
            {order.discount_code && <span className="font-mono"> ({order.discount_code})</span>}
          </dt>
          <dd className="text-right">−{formatMoney(totals.discount)}</dd>
        </>
      )}
      <dt className="text-text-secondary">
        Shipping{order.shipping_method && ` · ${order.shipping_method}`}
      </dt>
      <dd className="text-right">
        <MoneyText money={totals.shipping} />
      </dd>
      <dt className="text-text-secondary">Tax</dt>
      <dd className="text-right">
        <MoneyText money={totals.tax} />
      </dd>
      <dt className="border-border-subtle border-t pt-1 font-semibold">Total</dt>
      <dd className="border-border-subtle border-t pt-1 text-right font-semibold">
        <MoneyText money={totals.total} />
      </dd>
      {totals.refunded.amount > 0 && (
        <>
          <dt className="text-text-secondary">Refunded</dt>
          <dd className="text-right">−{formatMoney(totals.refunded)}</dd>
        </>
      )}
      <dt className="text-text-secondary">Left to refund</dt>
      <dd className="text-right">
        <MoneyText money={order.refundable} />
      </dd>
    </dl>
  );
}

const REASON_LABELS: Record<string, string> = {
  requested_by_customer: "Requested by customer",
  duplicate: "Duplicate charge",
  fraudulent: "Fraudulent",
  defective: "Defective",
  other: "Other",
};

function RefundHistory({ order }: { order: Order }) {
  const byId = new Map(order.lines.map((line) => [line.id, line]));
  const refunds = [...order.admin_refunds].sort((a, b) => b.created_at.localeCompare(a.created_at));
  return (
    <ul className="flex flex-col gap-3">
      {refunds.map((refund) => {
        const stuck =
          refund.status === "failed" || (refund.status === "pending" && refund.last_error !== null);
        return (
          <li
            key={refund.id}
            className={cn(
              "border-border-subtle rounded-md border p-3 text-sm",
              stuck && "border-warning/50 bg-warning/5",
            )}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-2 font-medium">
                <MoneyText money={refund.amount} />
                <RefundBadge status={refund.status} />
                {refund.return_id && <span className="text-text-secondary">· from a return</span>}
              </p>
              <time dateTime={refund.created_at} className="text-text-secondary text-xs">
                {formatDateTime(refund.created_at)}
              </time>
            </div>
            <p className="text-text-secondary mt-1">
              {REASON_LABELS[refund.reason] ?? refund.reason.replace(/_/g, " ")}
              {refund.provider_refund_id && (
                <>
                  {" "}
                  · <span className="font-mono text-xs">{refund.provider_refund_id}</span>
                </>
              )}
            </p>
            {refund.lines.length > 0 && (
              <ul className="mt-1">
                {refund.lines.map((entry) => {
                  const line = byId.get(String(entry["order_item_id"]));
                  return (
                    <li key={String(entry["order_item_id"])}>
                      {Number(entry["quantity"])} × {line?.product_title ?? "Item"}
                      {entry["restock"] === true && (
                        <span className="text-text-secondary"> · restocked</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {refund.note && <p className="mt-1 whitespace-pre-wrap">“{refund.note}”</p>}
            {(stuck || refund.attempts > 1) && (
              <p className="text-warning mt-1 flex items-start gap-1.5">
                <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  {refund.attempts} {refund.attempts === 1 ? "attempt" : "attempts"}
                  {refund.last_error && ` · ${refund.last_error}`}
                </span>
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function CustomerCard({ order }: { order: Order }) {
  const name = customerName(order);
  const shipping = addressLines(order.shipping_address);
  const billing = addressLines(order.billing_address);
  const sameAddress = shipping.join("|") === billing.join("|");
  return (
    <div className="flex flex-col gap-4 text-sm">
      <div>
        {name && <p className="font-medium">{name}</p>}
        <p className="break-all">{order.email}</p>
        <p className="text-text-secondary">{order.user_id ? "Has an account" : "Guest checkout"}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <a
              href={`mailto:${order.email}?subject=${encodeURIComponent(`Order ${order.number}`)}`}
            >
              <MailIcon aria-hidden />
              Contact
            </a>
          </Button>
          {order.user_id && (
            <IfCan permission="customers:read">
              <Button asChild variant="outline" size="sm">
                <Link href={`/customers/${order.user_id}`}>View customer</Link>
              </Button>
            </IfCan>
          )}
        </div>
      </div>
      <div>
        <p className="text-text-secondary text-xs font-medium uppercase tracking-wide">
          Delivery address
        </p>
        {shipping.length > 0 ? (
          <address className="not-italic">
            {shipping.map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
          </address>
        ) : (
          <p className="text-text-secondary">None</p>
        )}
      </div>
      <div>
        <p className="text-text-secondary text-xs font-medium uppercase tracking-wide">
          Billing address
        </p>
        {sameAddress ? (
          <p className="text-text-secondary">Same as delivery</p>
        ) : (
          <address className="not-italic">
            {billing.map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
          </address>
        )}
      </div>
    </div>
  );
}

function PaymentCard({ order }: { order: Order }) {
  const payment = order.payment;
  if (!payment) {
    return <p className="text-text-secondary text-sm">No payment has been captured.</p>;
  }
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      <dt className="text-text-secondary">Method</dt>
      <dd className="capitalize">{paymentLabel(order)}</dd>
      <dt className="text-text-secondary">Provider</dt>
      <dd className="capitalize">{payment.provider}</dd>
      <dt className="text-text-secondary">Captured</dt>
      <dd className="tabular-nums">
        <MoneyText money={payment.captured} />
      </dd>
      <dt className="text-text-secondary">Refunded</dt>
      <dd className="tabular-nums">
        <MoneyText money={payment.refunded} />
      </dd>
    </dl>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading order">
      <Skeleton className="h-9 w-64" />
      <Skeleton className="h-6 w-80" />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
        <div className="flex flex-col gap-4">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    </div>
  );
}
