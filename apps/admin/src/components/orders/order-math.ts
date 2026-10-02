import type { Schema } from "@velo/api-client";

/*
 * The order arithmetic the admin shows before it asks the server — a mirror
 * of apps/api/velo/domains/orders/rules.py and refunds.py `_plan`. The server
 * is the authority and prices every refund itself; this only makes the
 * preview say the same number the server will.
 */

type Order = Schema<"AdminOrderView">;
type Line = Schema<"OrderLineView">;

/** Refunds that count against the capture ledger: refunded or on the way. */
const COMMITTED = new Set(["pending", "succeeded"]);

/** What `units` more of a line are worth after `already` were refunded (rules.line_share). */
export function lineShare(total: number, quantity: number, already: number, units: number): number {
  if (quantity <= 0 || units <= 0) return 0;
  const done = Math.max(0, Math.min(already, quantity));
  const upto = Math.min(quantity, done + units);
  return Math.floor((total * upto) / quantity) - Math.floor((total * done) / quantity);
}

export interface LineLedger {
  /** Units refunded or being refunded. */
  refunded: number;
  /** Of those, refunded with restock — taken off the order, never to ship. */
  removed: number;
}

/** Per order line, what the committed refunds have already taken. */
export function refundLedger(order: Order): Map<string, LineLedger> {
  const ledger = new Map<string, LineLedger>();
  for (const refund of order.admin_refunds) {
    if (!COMMITTED.has(refund.status)) continue;
    for (const entry of refund.lines) {
      const id = String(entry["order_item_id"]);
      const quantity = Number(entry["quantity"] ?? 0);
      const current = ledger.get(id) ?? { refunded: 0, removed: 0 };
      ledger.set(id, {
        refunded: current.refunded + quantity,
        removed: current.removed + (entry["restock"] === true ? quantity : 0),
      });
    }
  }
  return ledger;
}

/** Money refunded beyond any line — shipping and goodwill (repository.extra_refunded). */
export function extraRefunded(order: Order): number {
  let extra = 0;
  for (const refund of order.admin_refunds) {
    if (!COMMITTED.has(refund.status)) continue;
    const lines = refund.lines.reduce((sum, entry) => sum + Number(entry["amount"] ?? 0), 0);
    extra += refund.amount.amount - lines;
  }
  return extra;
}

/** Shipping and its tax: what the order charged beyond its lines (rules.shipping_share). */
export function shippingShare(order: Order): number {
  const lines = order.lines.reduce((sum, line) => sum + line.total.amount, 0);
  return Math.max(0, order.totals.total.amount - lines);
}

/** Shipping not yet given back. Exact unless an earlier refund carried goodwill. */
export function shippingLeft(order: Order): number {
  return Math.max(0, shippingShare(order) - extraRefunded(order));
}

/** Units of a line that can still be refunded. */
export function refundableUnits(line: Line, ledger: Map<string, LineLedger>): number {
  return Math.max(0, line.quantity - (ledger.get(line.id)?.refunded ?? 0));
}

/** Units of a line not shipped and not taken off the order — what can still ship or restock. */
export function unshippedUnits(line: Line, ledger: Map<string, LineLedger>): number {
  return Math.max(0, line.quantity - line.quantity_fulfilled - (ledger.get(line.id)?.removed ?? 0));
}

export interface RefundSelection {
  lines: { id: string; quantity: number }[];
  includeShipping: boolean;
  /** Goodwill, minor units. */
  extra: number;
}

export interface RefundPreview {
  lines: number;
  shipping: number;
  extra: number;
  total: number;
  /** The capture ledger's ceiling. */
  refundable: number;
  exceeds: boolean;
}

export function previewRefund(order: Order, selection: RefundSelection): RefundPreview {
  const ledger = refundLedger(order);
  const byId = new Map(order.lines.map((line) => [line.id, line]));
  let lines = 0;
  for (const chosen of selection.lines) {
    const line = byId.get(chosen.id);
    if (!line || chosen.quantity <= 0) continue;
    lines += lineShare(
      line.total.amount,
      line.quantity,
      ledger.get(line.id)?.refunded ?? 0,
      chosen.quantity,
    );
  }
  const shipping = selection.includeShipping ? shippingLeft(order) : 0;
  const extra = Math.max(0, selection.extra);
  const total = lines + shipping + extra;
  return {
    lines,
    shipping,
    extra,
    total,
    refundable: order.refundable.amount,
    exceeds: total > order.refundable.amount,
  };
}

/** An address snapshot (JSON) as display lines; anything not a string is skipped. */
export function addressLines(address: Record<string, unknown>): string[] {
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
    text("phone"),
  ].filter(Boolean);
}

/** The name on the order: the shipping address's, if it has one. */
export function customerName(order: Order): string | null {
  const first = order.shipping_address["first_name"];
  const last = order.shipping_address["last_name"];
  const name = [first, last].filter((part) => typeof part === "string" && part).join(" ");
  return name || null;
}

/** Order statuses an operator may move to `processing` / `delivered` by hand (state.py). */
export const CAN_SET_PROCESSING = new Set(["paid", "partially_refunded"]);
export const CAN_SET_DELIVERED = new Set(["fulfilled"]);
/** Order statuses from which staff can cancel (state.py: → cancelled). */
export const CANCELLABLE = new Set(["pending", "paid", "partially_refunded", "processing"]);
/** Order statuses that can ship (fulfilment.py `_SHIPPABLE`). */
export const SHIPPABLE = new Set([
  "paid",
  "partially_refunded",
  "processing",
  "partially_fulfilled",
]);
/** Parcel moves allowed by staff (fulfilment.py `SHIPMENT_ALLOWED`). */
export const PARCEL_NEXT: Record<string, string[]> = {
  pending: ["in_transit", "cancelled"],
  in_transit: ["delivered", "failed"],
  failed: ["in_transit", "cancelled"],
  delivered: [],
  cancelled: [],
};

export const CARRIERS = [
  { value: "ups", label: "UPS" },
  { value: "usps", label: "USPS" },
  { value: "fedex", label: "FedEx" },
  { value: "dhl", label: "DHL" },
  { value: "royal_mail", label: "Royal Mail" },
  { value: "dpd", label: "DPD" },
  { value: "gig", label: "GIG Logistics" },
] as const;

export function carrierLabel(carrier: string | null | undefined): string {
  if (!carrier) return "Carrier";
  return CARRIERS.find((entry) => entry.value === carrier)?.label ?? carrier;
}
