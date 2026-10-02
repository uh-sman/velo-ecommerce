import { formatMoney, type Money } from "@velo/api-client";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface SummaryTotals {
  subtotal: Money;
  discount: Money;
  shipping: Money | null;
  tax: Money | null;
  tax_included: Money | null;
  total: Money;
}

export interface SummaryDiscount {
  code: string | null;
  title: string;
  amount: Money;
}

/*
 * DESIGN-SYSTEM.md §4 "OrderSummary": every line itemised, never a "Fees"
 * line; unknown shipping and tax read "Calculated at checkout", never $0.00;
 * tabular figures, right-aligned. The client renders the server's totals and
 * never computes one.
 */
export function OrderSummary({
  totals,
  itemCount,
  discounts = [],
  shippingLabel,
  onRemoveCode,
  className,
  children,
}: {
  totals: SummaryTotals;
  itemCount: number;
  discounts?: SummaryDiscount[];
  shippingLabel?: string | undefined;
  onRemoveCode?: (() => void) | undefined;
  className?: string;
  children?: ReactNode;
}) {
  const pending = "Calculated at checkout";
  return (
    <section
      aria-labelledby="order-summary-heading"
      className={cn("border-border-subtle flex flex-col gap-4 rounded-lg border p-5", className)}
    >
      <h2 id="order-summary-heading" className="text-lg font-semibold">
        Order summary
      </h2>
      <dl className="flex flex-col gap-2 text-sm tabular-nums">
        <Row label={`Subtotal (${String(itemCount)} ${itemCount === 1 ? "item" : "items"})`}>
          {formatMoney(totals.subtotal)}
        </Row>
        {discounts.length > 0
          ? discounts.map((discount) => (
              <Row
                key={`${discount.code ?? ""}${discount.title}`}
                label={
                  <span className="flex flex-wrap items-center gap-2">
                    {discount.code ? `Discount (${discount.code})` : discount.title}
                    {discount.code && onRemoveCode && (
                      <button
                        type="button"
                        onClick={onRemoveCode}
                        className="text-text-secondary hover:text-text-primary underline underline-offset-2"
                        aria-label={`Remove discount code ${discount.code}`}
                      >
                        Remove
                      </button>
                    )}
                  </span>
                }
              >
                −{formatMoney(discount.amount)}
              </Row>
            ))
          : totals.discount.amount > 0 && (
              <Row label="Discount">−{formatMoney(totals.discount)}</Row>
            )}
        <Row label={shippingLabel ? `Shipping — ${shippingLabel}` : "Shipping"}>
          {totals.shipping ? formatMoney(totals.shipping) : pending}
        </Row>
        {totals.tax_included ? (
          <Row label="Tax (included)">{formatMoney(totals.tax_included)}</Row>
        ) : (
          <Row label="Tax">{totals.tax ? formatMoney(totals.tax) : pending}</Row>
        )}
        <div className="border-border-subtle mt-2 flex items-baseline justify-between border-t pt-3 text-base font-semibold">
          <dt>Total</dt>
          <dd aria-live="polite">{formatMoney(totals.total)}</dd>
        </div>
      </dl>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-text-secondary">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}
