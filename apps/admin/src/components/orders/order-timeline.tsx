"use client";

import { formatMoney, type Schema } from "@velo/api-client";
import { ArrowRightIcon } from "lucide-react";

import { formatDateTime } from "@/components/page";
import { useMe } from "@/components/shell/me-context";
import { statusLabel } from "@/components/status";

type Order = Schema<"AdminOrderView">;
type Event = Schema<"OrderEventView">;

const TITLES: Record<string, string> = {
  created: "Order placed",
  paid: "Payment captured",
  status_changed: "Status changed",
  note_updated: "Internal note updated",
  partially_fulfilled: "Parcel shipped (part of the order)",
  fulfilled: "Parcel shipped",
  delivered: "Delivered",
  cancelled: "Order cancelled",
  refund_requested: "Refund issued",
  refunded: "Refund settled",
  dispute_opened: "Payment disputed",
  return_requested: "Return requested",
  shipment_in_transit: "Parcel in transit",
  shipment_delivered: "Parcel delivered",
  shipment_failed: "Parcel delivery failed",
  shipment_cancelled: "Parcel cancelled",
  shipment_updated: "Parcel tracking updated",
  return_approved: "Return approved",
  return_rejected: "Return rejected",
  return_in_transit: "Return on its way back",
  return_received: "Return received",
  return_refunded: "Return refunded",
  return_closed: "Return closed",
};

function title(event: Event): string {
  const known = TITLES[event.event_type];
  if (known) return known;
  const text = event.event_type.replace(/[._]/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Keys whose values are minor-unit amounts in the order's currency. */
const MONEY_KEYS = new Set(["amount", "refunded", "total", "refund_amount", "extra_amount"]);
/** Keys too noisy to show inline. */
const HIDDEN_KEYS = new Set(["refund_id", "order_item_id", "source", "complete", "items_detail"]);

function humanKey(key: string): string {
  const text = key.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The payload as a few short "Key: value" phrases — the audit trail, readable. */
export function payloadSummary(payload: Record<string, unknown>, currency: string): string[] {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (HIDDEN_KEYS.has(key) || value === null || value === undefined || value === "") continue;
    if (MONEY_KEYS.has(key) && typeof value === "number") {
      parts.push(`${humanKey(key)}: ${formatMoney({ amount: value, currency })}`);
    } else if (Array.isArray(value)) {
      const units = value.reduce<number>((sum, entry) => {
        const quantity =
          typeof entry === "object" && entry !== null && "quantity" in entry
            ? Number((entry as { quantity: unknown }).quantity)
            : 0;
        return sum + (Number.isFinite(quantity) ? quantity : 0);
      }, 0);
      if (value.length > 0) {
        parts.push(
          units > 0
            ? `${humanKey(key)}: ${String(units)} ${units === 1 ? "unit" : "units"}`
            : `${humanKey(key)}: ${String(value.length)}`,
        );
      }
    } else if (typeof value === "object") {
      if (key === "status" && "from" in value && "to" in value) {
        parts.push(`Status: ${String(value.from)} → ${String(value.to)}`);
      }
      // Other nested objects are left to the audit log.
    } else if (typeof value === "boolean") {
      if (value) parts.push(humanKey(key));
    } else if (typeof value === "string" || typeof value === "number") {
      const text = String(value);
      parts.push(`${humanKey(key)}: ${text.length > 160 ? `${text.slice(0, 157)}…` : text}`);
    }
  }
  return parts;
}

function actorLabel(event: Event, meId: string): string {
  if (event.actor_type === "staff") {
    return event.actor_id && event.actor_id === meId ? "You" : "Staff";
  }
  if (event.actor_type === "customer") return "Customer";
  if (event.actor_type === "webhook") return "Carrier / provider";
  return "System";
}

/**
 * The order's events, oldest first — append-only, the audit trail rendered
 * (PAGE-SPECS.md §3.5). Staff are named "Staff" because the view carries only
 * their id.
 */
export function OrderTimeline({ order }: { order: Order }) {
  const me = useMe();
  const events = [...order.events].sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (events.length === 0) {
    return <p className="text-text-secondary text-sm">Nothing has happened to this order yet.</p>;
  }
  return (
    <ol className="border-border-subtle relative ml-2 flex flex-col gap-5 border-l pl-5">
      {events.map((event) => {
        const details = payloadSummary(event.payload, order.currency);
        return (
          <li key={event.id} className="relative">
            <span
              className="bg-border-default ring-surface-raised absolute -left-[1.6rem] top-1.5 size-2.5 rounded-full ring-4"
              aria-hidden
            />
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <p className="font-medium">{title(event)}</p>
              <time dateTime={event.created_at} className="text-text-secondary text-xs">
                {formatDateTime(event.created_at)}
              </time>
            </div>
            <p className="text-text-secondary text-sm">
              {actorLabel(event, me.id)}
              {(event.from_status || event.to_status) && event.from_status !== event.to_status && (
                <span className="ml-2 inline-flex items-center gap-1">
                  {event.from_status ? statusLabel(event.from_status) : "—"}
                  <ArrowRightIcon className="size-3" aria-label="to" role="img" />
                  {event.to_status ? statusLabel(event.to_status) : "—"}
                </span>
              )}
            </p>
            {details.length > 0 && (
              <ul className="text-text-secondary mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
                {details.map((detail) => (
                  <li key={detail} className="break-words">
                    {detail}
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}
