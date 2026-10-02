"use client";

import { formatMoney, type Schema } from "@velo/api-client";
import { FileTextIcon, PackageIcon, TruckIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { StatusBadge } from "@/components/orders/status";
import { FormAlert } from "@/components/forms/fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { notify } from "@/components/ui/sonner";
import { callApi, fieldErrors } from "@/lib/api-browser";
import { apiUrl, cn, formatDate } from "@/lib/utils";

type Order = Schema<"OrderView">;
type Line = Schema<"OrderLineView">;

const REASONS: { value: Schema<"RequestReturn">["reason"]; label: string }[] = [
  { value: "wrong_size", label: "Wrong size or fit" },
  { value: "changed_mind", label: "Changed my mind" },
  { value: "not_as_described", label: "Not as described" },
  { value: "damaged", label: "Arrived damaged" },
  { value: "defective", label: "Faulty" },
  { value: "wrong_item", label: "Wrong item sent" },
  { value: "other", label: "Something else" },
];

/*
 * PAGE-SPECS.md §2.4: a timeline, items grouped by shipment with their own
 * tracking (a partly shipped order is shown as it is), returns and refunds,
 * and the actions the order allows right now — cancel, return, invoice.
 * Used for the signed-in account and for a guest's signed link alike.
 */
export function OrderDetail({ initial }: { initial: Order }) {
  const [order, setOrder] = useState(initial);
  const [cancelling, setCancelling] = useState(false);
  const [returning, setReturning] = useState(false);
  const token = order.access_token;
  const query = token ? `?token=${token}` : "";
  const byId = new Map(order.lines.map((line) => [line.id, line]));
  const shippedIds = new Set(
    order.shipments.flatMap((s) => s.lines.map((l) => String(l.order_item_id))),
  );
  // A cancelled order lists everything it was; otherwise, what has not shipped.
  const cancelled = order.status === "cancelled";
  const remaining = (line: Line) =>
    cancelled ? line.quantity : line.quantity - line.quantity_fulfilled - line.quantity_refunded;
  const unshipped = order.lines.filter((line) => remaining(line) > 0);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Order <span className="select-all font-mono">{order.number}</span>
          </h1>
          <p className="text-text-secondary mt-1 text-sm">Placed {formatDate(order.placed_at)}</p>
        </div>
        <StatusBadge status={order.status} className="text-sm" />
      </header>

      <Timeline order={order} />

      {order.shipments.map((shipment, index) => (
        <section
          key={shipment.id}
          aria-labelledby={`shipment-${shipment.id}`}
          className="border-border-subtle flex flex-col gap-3 rounded-lg border p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id={`shipment-${shipment.id}`} className="flex items-center gap-2 font-semibold">
              <TruckIcon className="size-4" aria-hidden />
              {order.shipments.length > 1 ? `Parcel ${String(index + 1)}` : "Your parcel"}
              <StatusBadge
                status={shipment.status === "in_transit" ? "fulfilled" : shipment.status}
              />
            </h2>
            {shipment.tracking_url ? (
              <Button asChild variant="outline" size="sm">
                <a href={shipment.tracking_url} target="_blank" rel="noopener noreferrer">
                  Track with {shipment.carrier?.toUpperCase() ?? "the carrier"}
                </a>
              </Button>
            ) : shipment.tracking_number ? (
              <p className="text-sm">
                {shipment.carrier} tracking number:{" "}
                <span className="font-mono">{shipment.tracking_number}</span>
              </p>
            ) : null}
          </div>
          <ul className="divide-border-subtle divide-y">
            {shipment.lines.map((entry) => {
              const line = byId.get(String(entry.order_item_id));
              return line ? (
                <LineRow key={line.id} line={line} quantity={Number(entry.quantity)} />
              ) : null;
            })}
          </ul>
        </section>
      ))}

      {unshipped.length > 0 && (
        <section
          aria-labelledby="unshipped-heading"
          className="border-border-subtle flex flex-col gap-3 rounded-lg border p-4"
        >
          <h2 id="unshipped-heading" className="flex items-center gap-2 font-semibold">
            <PackageIcon className="size-4" aria-hidden />
            {cancelled ? "Cancelled items" : shippedIds.size > 0 ? "Still to ship" : "Items"}
          </h2>
          <ul className="divide-border-subtle divide-y">
            {unshipped.map((line) => (
              <LineRow key={line.id} line={line} quantity={remaining(line)} />
            ))}
          </ul>
        </section>
      )}

      {order.returns.length > 0 && (
        <section aria-labelledby="returns-heading" className="flex flex-col gap-3">
          <h2 id="returns-heading" className="font-semibold">
            Returns
          </h2>
          <ul className="flex flex-col gap-3">
            {order.returns.map((returned) => (
              <li
                key={returned.id}
                className="border-border-subtle flex flex-col gap-2 rounded-lg border p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">
                    Return <span className="font-mono">{returned.rma_number}</span>
                  </p>
                  <StatusBadge status={returned.status} />
                </div>
                <p className="text-text-secondary text-sm">
                  {returned.lines
                    .map(
                      (l) =>
                        `${String(l.quantity)} × ${byId.get(String(l.order_item_id))?.product_title ?? "item"}`,
                    )
                    .join(", ")}
                </p>
                {returned.status === "approved" && (
                  <div className="flex flex-col gap-2 text-sm">
                    <p>
                      Approved. Print the label, pack the items with it, and send the parcel to the
                      address on it. Write {returned.rma_number} on the outside.
                    </p>
                    <Button asChild variant="outline" size="sm" className="self-start">
                      <a
                        href={apiUrl(
                          `/api/v1/orders/${order.number}/returns/${returned.rma_number}/label${query}`,
                        )}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Print return label
                      </a>
                    </Button>
                  </div>
                )}
                {returned.status === "rejected" && returned.staff_note && (
                  <p className="text-sm">Reason: {returned.staff_note}</p>
                )}
                {returned.refund_amount && (
                  <p className="text-sm">
                    Refund of {formatMoney(returned.refund_amount)} issued — it reaches your card in
                    5–10 business days.
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid gap-6 md:grid-cols-3">
        <section aria-labelledby="summary-heading" className="flex flex-col gap-2 text-sm">
          <h2 id="summary-heading" className="font-semibold">
            Summary
          </h2>
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 tabular-nums">
            <dt className="text-text-secondary">Subtotal</dt>
            <dd className="text-right">{formatMoney(order.totals.subtotal)}</dd>
            {order.totals.discount.amount > 0 && (
              <>
                <dt className="text-text-secondary">
                  Discount{order.discount_code ? ` (${order.discount_code})` : ""}
                </dt>
                <dd className="text-right">−{formatMoney(order.totals.discount)}</dd>
              </>
            )}
            <dt className="text-text-secondary">
              Shipping{order.shipping_method ? ` — ${order.shipping_method}` : ""}
            </dt>
            <dd className="text-right">{formatMoney(order.totals.shipping)}</dd>
            <dt className="text-text-secondary">Tax</dt>
            <dd className="text-right">{formatMoney(order.totals.tax)}</dd>
            <dt className="font-semibold">Total</dt>
            <dd className="text-right font-semibold">{formatMoney(order.totals.total)}</dd>
            {order.totals.refunded.amount > 0 && (
              <>
                <dt className="text-text-secondary">Refunded</dt>
                <dd className="text-right">−{formatMoney(order.totals.refunded)}</dd>
              </>
            )}
          </dl>
        </section>
        <section aria-labelledby="address-heading" className="flex flex-col gap-2 text-sm">
          <h2 id="address-heading" className="font-semibold">
            Delivery address
          </h2>
          <address className="text-text-secondary not-italic">
            {addressLines(order.shipping_address).map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
          </address>
        </section>
        <section aria-labelledby="payment-heading" className="flex flex-col gap-2 text-sm">
          <h2 id="payment-heading" className="font-semibold">
            Payment
          </h2>
          <p className="text-text-secondary">
            {order.payment?.card_brand && order.payment.card_last4
              ? `${order.payment.card_brand.toUpperCase()} •••• ${order.payment.card_last4}`
              : (order.payment?.method ?? "Paid")}
          </p>
        </section>
      </div>

      <div className="flex flex-wrap gap-3">
        <Button asChild variant="outline">
          <a
            href={apiUrl(`/api/v1/orders/${order.number}/invoice${query}`)}
            target="_blank"
            rel="noopener noreferrer"
          >
            <FileTextIcon aria-hidden /> Invoice (PDF)
          </a>
        </Button>
        {order.can_return && (
          <Button
            variant="outline"
            onClick={() => {
              setReturning(true);
            }}
          >
            Request a return
          </Button>
        )}
        {order.can_cancel && (
          <Button
            variant="ghost"
            onClick={() => {
              setCancelling(true);
            }}
          >
            Cancel order
          </Button>
        )}
      </div>

      <CancelDialog
        order={order}
        open={cancelling}
        onClose={() => {
          setCancelling(false);
        }}
        onDone={(next) => {
          setOrder(next);
          setCancelling(false);
        }}
      />
      <ReturnDialog
        order={order}
        open={returning}
        onClose={() => {
          setReturning(false);
        }}
        onDone={(created) => {
          setReturning(false);
          setOrder({
            ...order,
            returns: [...order.returns, created],
            lines: order.lines.map((line) => {
              const claimed = created.lines.find((l) => String(l.order_item_id) === line.id);
              return claimed
                ? { ...line, returnable_quantity: line.returnable_quantity - claimed.quantity }
                : line;
            }),
          });
        }}
      />
    </div>
  );
}

/** An address snapshot (JSON) as display lines; anything not a string is skipped. */
function addressLines(address: Record<string, unknown>): string[] {
  const text = (key: string) => {
    const value = address[key];
    return typeof value === "string" ? value : "";
  };
  return [
    `${text("first_name")} ${text("last_name")}`.trim(),
    text("company"),
    text("line1"),
    text("line2"),
    [text("city"), text("region"), text("postal_code")].filter(Boolean).join(", "),
    text("country_code"),
  ].filter(Boolean);
}

function LineRow({ line, quantity }: { line: Line; quantity: number }) {
  return (
    <li className="flex gap-3 py-3">
      <div className="bg-surface-sunken relative size-16 shrink-0 overflow-hidden rounded-md">
        {line.image_url && (
          <Image
            src={line.image_url}
            alt=""
            fill
            sizes="64px"
            className="object-cover"
            unoptimized
          />
        )}
      </div>
      <div className="flex min-w-0 flex-1 justify-between gap-3 text-sm">
        <div>
          <p className="font-medium">{line.product_title}</p>
          <p className="text-text-secondary">
            {line.variant_title} · × {quantity}
          </p>
          {line.quantity_returned > 0 && (
            <p className="text-text-secondary text-xs">{line.quantity_returned} returned</p>
          )}
        </div>
        <p className="tabular-nums">{formatMoney(line.total)}</p>
      </div>
    </li>
  );
}

function Timeline({ order }: { order: Order }) {
  const steps: { label: string; at: string | null; done: boolean }[] = [
    { label: "Ordered", at: order.placed_at, done: true },
  ];
  if (order.status === "cancelled") {
    steps.push({ label: "Cancelled", at: order.cancelled_at, done: true });
  } else {
    const shipped =
      order.shipments
        .map((s) => s.shipped_at)
        .filter(Boolean)
        .sort()[0] ?? null;
    const delivered = order.shipments.every((s) => s.delivered_at)
      ? (order.shipments
          .map((s) => s.delivered_at)
          .filter(Boolean)
          .sort()
          .at(-1) ?? null)
      : null;
    steps.push({ label: "Shipped", at: shipped, done: shipped !== null });
    steps.push({
      label: "Delivered",
      at: order.shipments.length ? delivered : null,
      done: order.status === "delivered" || (order.shipments.length > 0 && delivered !== null),
    });
  }
  for (const refund of order.refunds) {
    steps.push({
      label: `Refunded ${formatMoney(refund.amount)}${refund.status === "pending" ? " (processing)" : ""}`,
      at: refund.created_at,
      done: true,
    });
  }
  return (
    <ol
      className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:gap-8"
      aria-label="Order progress"
    >
      {steps.map((step) => (
        <li key={step.label} className="flex items-center gap-2 text-sm">
          <span
            aria-hidden
            className={cn(
              "size-3 rounded-full border-2",
              step.done ? "bg-success border-success" : "border-border-strong",
            )}
          />
          <span className={cn(!step.done && "text-text-tertiary")}>
            {step.label}
            {step.at ? ` · ${formatDate(step.at)}` : ""}
            {!step.done && <span className="sr-only"> (not yet)</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

function CancelDialog({
  order,
  open,
  onClose,
  onDone,
}: {
  order: Order;
  open: boolean;
  onClose: () => void;
  onDone: (order: Order) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setPending(true);
    setError(null);
    const outcome = await callApi((client) =>
      client.POST("/api/v1/orders/{number}/cancel", {
        params: {
          path: { number: order.number },
          query: order.access_token ? { token: order.access_token } : {},
        },
        body: {},
      }),
    );
    setPending(false);
    if (outcome.ok) {
      notify.success("Your order is cancelled. The refund is on its way.");
      onDone(outcome.data);
    } else {
      setError(outcome.problem.detail ?? outcome.problem.title);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel order {order.number}?</DialogTitle>
          <DialogDescription>
            Everything you paid, {formatMoney(order.totals.total)}, goes back to your original
            payment method. It usually arrives in 5–10 business days.
          </DialogDescription>
        </DialogHeader>
        {error && <FormAlert title="The order was not cancelled">{error}</FormAlert>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Keep my order
          </Button>
          <Button variant="danger" loading={pending} onClick={() => void confirm()}>
            Cancel order
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReturnDialog({
  order,
  open,
  onClose,
  onDone,
}: {
  order: Order;
  open: boolean;
  onClose: () => void;
  onDone: (created: Schema<"ReturnView">) => void;
}) {
  const returnable = order.lines.filter((line) => line.returnable_quantity > 0);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [reason, setReason] = useState<Schema<"RequestReturn">["reason"] | "">("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const router = useRouter();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const items = Object.entries(quantities)
      .filter(([, quantity]) => quantity > 0)
      .map(([id, quantity]) => ({ order_item_id: id, quantity }));
    if (items.length === 0) {
      setError("Choose at least one item to return.");
      return;
    }
    if (!reason) {
      setError("Choose a reason.");
      return;
    }
    setPending(true);
    setError(null);
    const outcome = await callApi((client) =>
      client.POST("/api/v1/orders/{number}/returns", {
        params: {
          path: { number: order.number },
          query: order.access_token ? { token: order.access_token } : {},
        },
        body: { items, reason, note: note || null },
      }),
    );
    setPending(false);
    if (outcome.ok) {
      notify.success(`Return ${outcome.data.rma_number} requested. We will email you next steps.`);
      onDone(outcome.data);
      router.refresh();
    } else {
      setError(
        Object.values(fieldErrors(outcome.problem))[0] ??
          outcome.problem.detail ??
          outcome.problem.title,
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Return items</DialogTitle>
          <DialogDescription>
            Choose what you are sending back. Once we approve it you can print a return label.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">Items</legend>
            {returnable.map((line) => (
              <label key={line.id} className="flex items-center justify-between gap-3 text-sm">
                <span>
                  {line.product_title}
                  <span className="text-text-secondary block">{line.variant_title}</span>
                </span>
                <select
                  aria-label={`How many ${line.product_title} to return`}
                  value={quantities[line.id] ?? 0}
                  onChange={(event) => {
                    setQuantities({ ...quantities, [line.id]: Number(event.target.value) });
                  }}
                  className="border-border-default bg-surface-raised h-11 rounded-md border px-3"
                >
                  {Array.from({ length: line.returnable_quantity + 1 }, (_, n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </fieldset>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Reason
            <select
              value={reason}
              onChange={(event) => {
                setReason(event.target.value as Schema<"RequestReturn">["reason"]);
              }}
              className="border-border-default bg-surface-raised h-11 rounded-md border px-3 font-normal"
            >
              <option value="" disabled>
                Choose a reason
              </option>
              {REASONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            <span>
              Anything we should know?{" "}
              <span className="text-text-tertiary font-normal">(optional)</span>
            </span>
            <textarea
              rows={3}
              value={note}
              maxLength={2000}
              onChange={(event) => {
                setNote(event.target.value);
              }}
              className="border-border-default bg-surface-raised rounded-md border p-3 font-normal"
            />
          </label>
          {error && (
            <p role="alert" className="text-danger text-sm">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Not now
            </Button>
            <Button type="submit" loading={pending}>
              Request return
            </Button>
          </DialogFooter>
        </form>
        <p className="text-text-secondary text-xs">
          Returns are accepted within 30 days of delivery.{" "}
          <Link href="/help/returns" className="underline">
            Returns policy
          </Link>
        </p>
      </DialogContent>
    </Dialog>
  );
}
