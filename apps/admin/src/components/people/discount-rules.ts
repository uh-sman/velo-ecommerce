import { formatMoney, type Schema } from "@velo/api-client";

import { toMajor, toMinor } from "@/components/page";

/*
 * The discount builder's form state, its translation to and from the API, and
 * the plain-English sentence that reads a rule back (PAGE-SPECS.md §3.6). The
 * sentence is a pure function of the draft, so it updates on every keystroke.
 */

export type DiscountType = Schema<"DiscountFields">["type"];
export type AppliesTo = Schema<"DiscountFields">["applies_to"];
export type Segment = Schema<"DiscountFields">["customer_segment"];
export type DiscountStatus = Schema<"DiscountView">["status"];

export interface Target {
  id: string;
  label: string;
}

/** What the operator types: strings for every number, major units for money. */
export interface Draft {
  code: string;
  title: string;
  type: DiscountType;
  value: string; // percent for percentage / buy_x_get_y, major units for fixed_amount
  currency: string;
  buyQuantity: string;
  getQuantity: string;
  minSubtotal: string; // major units, blank: none
  appliesTo: AppliesTo;
  targets: Target[];
  segment: Segment;
  firstOrderOnly: boolean;
  maxRedemptions: string;
  maxPerCustomer: string;
  stackable: boolean;
  startsAt: string; // datetime-local, blank: now
  endsAt: string; // datetime-local, blank: never
  isActive: boolean;
}

export function emptyDraft(currency = "USD"): Draft {
  return {
    code: "",
    title: "",
    type: "percentage",
    value: "",
    currency,
    buyQuantity: "",
    getQuantity: "",
    minSubtotal: "",
    appliesTo: "all",
    targets: [],
    segment: "all",
    firstOrderOnly: false,
    maxRedemptions: "",
    maxPerCustomer: "",
    stackable: false,
    startsAt: "",
    endsAt: "",
    isActive: true,
  };
}

/** An ISO instant as the value of a `datetime-local` input, in this browser's zone. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** "20.0000" → "20". */
function trimDecimal(value: string): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(parsed) : value;
}

export function draftFromView(view: Schema<"DiscountView">, labels: Target[]): Draft {
  const type = view.type as DiscountType;
  return {
    code: view.code ?? "",
    title: view.title,
    type,
    value:
      type === "fixed_amount" ? toMajor(Math.round(Number(view.value))) : trimDecimal(view.value),
    currency: view.currency ?? "USD",
    buyQuantity: view.buy_quantity === null ? "" : String(view.buy_quantity),
    getQuantity: view.get_quantity === null ? "" : String(view.get_quantity),
    minSubtotal: toMajor(view.min_subtotal_amount),
    appliesTo: view.applies_to as AppliesTo,
    targets: view.target_ids.map(
      (id) => labels.find((target) => target.id === id) ?? { id, label: "Unknown item" },
    ),
    segment: view.customer_segment as Segment,
    firstOrderOnly: view.first_order_only,
    maxRedemptions: view.max_redemptions === null ? "" : String(view.max_redemptions),
    maxPerCustomer: view.max_per_customer === null ? "" : String(view.max_per_customer),
    stackable: view.is_stackable,
    startsAt: toLocalInput(view.starts_at),
    endsAt: toLocalInput(view.ends_at),
    isActive: view.is_active,
  };
}

function whole(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

/** The draft as the API's `DiscountFields`. */
export function draftToFields(draft: Draft): Schema<"DiscountFields"> {
  const code = draft.code.trim().toUpperCase();
  let value = "0";
  if (draft.type === "fixed_amount") value = String(toMinor(draft.value) ?? 0);
  else if (draft.type !== "free_shipping") value = draft.value.trim() || "0";
  const minSubtotal = draft.minSubtotal.trim() ? toMinor(draft.minSubtotal) : null;
  return {
    code: code || null,
    title: draft.title.trim(),
    type: draft.type,
    value,
    currency: draft.type === "fixed_amount" ? draft.currency.trim().toUpperCase() || null : null,
    min_subtotal_amount: minSubtotal,
    applies_to: draft.appliesTo,
    target_ids: draft.appliesTo === "all" ? null : draft.targets.map((target) => target.id),
    first_order_only: draft.firstOrderOnly,
    max_redemptions: whole(draft.maxRedemptions),
    max_per_customer: whole(draft.maxPerCustomer),
    is_stackable: draft.stackable,
    starts_at: fromLocalInput(draft.startsAt),
    ends_at: fromLocalInput(draft.endsAt),
    is_active: draft.isActive,
    buy_quantity: draft.type === "buy_x_get_y" ? whole(draft.buyQuantity) : null,
    get_quantity: draft.type === "buy_x_get_y" ? whole(draft.getQuantity) : null,
    customer_segment: draft.segment,
  };
}

/**
 * Only what changed, for `PATCH`. A redeemed discount refuses changes to its
 * terms, so sending unchanged terms back would be refused for nothing.
 */
export function changedFields(
  before: Draft,
  after: Draft,
): Partial<Record<keyof Schema<"DiscountFields">, unknown>> {
  const a = draftToFields(before) as Record<string, unknown>;
  const b = draftToFields(after) as Record<string, unknown>;
  const changes: Record<string, unknown> = {};
  for (const key of Object.keys(b)) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) changes[key] = b[key];
  }
  // A blank start on an existing discount means "leave it", not "clear it".
  if (changes["starts_at"] === null) delete changes["starts_at"];
  return changes;
}

const SEGMENT_PHRASE: Record<Segment, string | null> = {
  all: null,
  returning: "for returning customers",
  subscribers: "for newsletter subscribers",
  staff: "for staff only",
};

function money(major: string, currency: string): string | null {
  const minor = toMinor(major);
  if (minor === null) return null;
  try {
    return formatMoney({ amount: minor, currency: currency || "USD" });
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

function shortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

function listTargets(targets: Target[], noun: string): string {
  if (targets.length === 0) return `the chosen ${noun}`;
  const names = targets.map((target) => target.label);
  if (names.length <= 3) {
    return names.length === 1
      ? (names[0] ?? "")
      : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
  }
  return `${names.slice(0, 2).join(", ")} and ${String(names.length - 2)} more ${noun}`;
}

function scope(draft: Draft): string {
  if (draft.appliesTo === "products") return listTargets(draft.targets, "products");
  if (draft.appliesTo === "collections") {
    return draft.targets.length === 0
      ? "the chosen collections"
      : `everything in ${listTargets(draft.targets, "collections")}`;
  }
  return "everything";
}

/** "20% off everything, with code SPRING20, for a customer's first order, on orders of $50 or more, until 30 Sep." */
export function describeDraft(draft: Draft): string {
  const parts: string[] = [];
  const value = draft.value.trim() || "…";
  switch (draft.type) {
    case "percentage":
      parts.push(`${value}% off ${scope(draft)}`);
      break;
    case "fixed_amount":
      parts.push(
        `${money(draft.value, draft.currency) ?? `${value} ${draft.currency}`} off ${scope(draft)}`,
      );
      break;
    case "free_shipping":
      parts.push(
        draft.appliesTo === "all"
          ? "Free shipping on the whole order"
          : `Free shipping when the order includes ${scope(draft)}`,
      );
      break;
    case "buy_x_get_y": {
      const buy = draft.buyQuantity.trim() || "…";
      const get = draft.getQuantity.trim() || "…";
      const reward = Number(draft.value) === 100 ? "free" : `${value}% off`;
      const from = draft.appliesTo === "all" ? "" : ` from ${scope(draft)}`;
      parts.push(`Buy ${buy}, get ${get} ${reward}${from} (the cheapest items are discounted)`);
      break;
    }
  }
  const code = draft.code.trim().toUpperCase();
  parts.push(code ? `with code ${code}` : "applied automatically, no code needed");
  const segment = SEGMENT_PHRASE[draft.segment];
  if (segment) parts.push(segment);
  if (draft.firstOrderOnly) parts.push("for a customer's first order");
  const minimum = draft.minSubtotal.trim() ? money(draft.minSubtotal, draft.currency) : null;
  if (minimum) parts.push(`on orders of ${minimum} or more`);
  const total = whole(draft.maxRedemptions);
  if (total !== null) parts.push(`limited to ${String(total)} ${total === 1 ? "use" : "uses"}`);
  const perCustomer = whole(draft.maxPerCustomer);
  if (perCustomer === 1) parts.push("once per customer");
  else if (perCustomer !== null) parts.push(`up to ${String(perCustomer)} times per customer`);
  parts.push(
    draft.stackable ? "combines with other discounts" : "does not combine with other discounts",
  );
  const starts = draft.startsAt && new Date(draft.startsAt) > new Date() ? draft.startsAt : "";
  if (starts && draft.endsAt)
    parts.push(`from ${shortDate(starts)} until ${shortDate(draft.endsAt)}`);
  else if (starts) parts.push(`from ${shortDate(starts)}`);
  else if (draft.endsAt) parts.push(`until ${shortDate(draft.endsAt)}`);
  const sentence = `${parts.join(", ")}.`;
  return draft.isActive
    ? sentence
    : `Switched off — ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`;
}

/** A worked example for the simple cases: "a $150.00 order pays $120.00". */
export function workedExample(draft: Draft): string | null {
  if (draft.appliesTo !== "all") return null;
  if (draft.type !== "percentage" && draft.type !== "fixed_amount") return null;
  const minimum = draft.minSubtotal.trim() ? (toMinor(draft.minSubtotal) ?? 0) : 0;
  const cart = Math.max(10000, Math.ceil((minimum * 1.5) / 1000) * 1000);
  let off = 0;
  if (draft.type === "percentage") {
    const percent = Number(draft.value);
    if (!(percent > 0 && percent <= 100)) return null;
    off = Math.round((cart * percent) / 100);
  } else {
    const amount = toMinor(draft.value);
    if (amount === null || amount <= 0) return null;
    off = Math.min(amount, cart);
  }
  try {
    const currency = draft.currency || "USD";
    return `Example: an order of ${formatMoney({ amount: cart, currency })} pays ${formatMoney({
      amount: cart - off,
      currency,
    })} before shipping and tax.`;
  } catch {
    return null;
  }
}

/** Why a sample basket does not qualify, from the pricing engine's code. */
export const CART_PROBLEMS: Record<string, string> = {
  min_subtotal: "The basket is below the minimum order amount.",
  no_targets: "Nothing in the basket is a product or collection this discount applies to.",
  not_enough_items: "There are not enough qualifying items for “buy X get Y”.",
  currency: "The discount's currency is not the store's currency, so it cannot apply.",
  nothing_to_ship:
    "Nothing in the basket needs shipping, so free shipping has nothing to discount.",
  outclassed: "It qualifies, but another discount gives the customer a better price.",
};

export const STATUS_TONE: Record<DiscountStatus, "success" | "info" | "neutral" | "warning"> = {
  active: "success",
  scheduled: "info",
  expired: "neutral",
  used_up: "warning",
  inactive: "neutral",
};

export const STATUS_LABEL: Record<DiscountStatus, string> = {
  active: "Active",
  scheduled: "Scheduled",
  expired: "Expired",
  used_up: "Used up",
  inactive: "Inactive",
};

/** A short label for the list: "20% off", "$10.00 off", "Free shipping", "Buy 2 get 1". */
export function valueLabel(view: Schema<"DiscountView">): string {
  switch (view.type) {
    case "percentage":
      return `${trimDecimal(view.value)}% off`;
    case "fixed_amount":
      try {
        return `${formatMoney({ amount: Math.round(Number(view.value)), currency: view.currency ?? "USD" })} off`;
      } catch {
        return `${view.value} off`;
      }
    case "free_shipping":
      return "Free shipping";
    case "buy_x_get_y":
      return `Buy ${String(view.buy_quantity ?? "?")} get ${String(view.get_quantity ?? "?")}${
        Number(view.value) === 100 ? " free" : ` at ${trimDecimal(view.value)}% off`
      }`;
    default:
      return view.type;
  }
}

/** A random, readable code: no 0/O or 1/I to misread on a flyer. */
export function generateCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length] ?? "X").join("");
}
