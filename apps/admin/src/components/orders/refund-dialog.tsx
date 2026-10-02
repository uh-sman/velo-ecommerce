"use client";

import { formatMoney, type Schema } from "@velo/api-client";
import { useState, type FormEvent } from "react";

import { FieldError, FormAlert, TextField } from "@/components/forms/fields";
import { toMinor } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { notify } from "@/components/ui/sonner";
import { callApi, fieldErrors, problemSlug } from "@/lib/api-browser";
import { cn } from "@/lib/utils";

import { NativeSelect } from "./native-select";
import {
  previewRefund,
  refundLedger,
  refundableUnits,
  unshippedUnits,
  type RefundSelection,
} from "./order-math";

type Order = Schema<"AdminOrderView">;
type Refund = Schema<"AdminRefundView">;
type Reason = Schema<"CreateRefund">["reason"];

const REASONS: { value: Reason; label: string }[] = [
  { value: "requested_by_customer", label: "Requested by customer" },
  { value: "defective", label: "Defective or damaged" },
  { value: "duplicate", label: "Duplicate charge" },
  { value: "fraudulent", label: "Fraudulent" },
  { value: "other", label: "Other" },
];

interface LinePick {
  selected: boolean;
  quantity: string;
  restock: boolean;
}

/** "Visa •••• 4242", or the method, or a plain fallback. */
export function paymentLabel(order: Order): string {
  const payment = order.payment;
  if (!payment) return "the original payment method";
  if (payment.card_brand && payment.card_last4) {
    const brand = payment.card_brand.charAt(0).toUpperCase() + payment.card_brand.slice(1);
    return `${brand} •••• ${payment.card_last4}`;
  }
  if (payment.method) return payment.method.replace(/_/g, " ");
  return `the ${payment.provider} payment`;
}

function money(amount: number, currency: string): string {
  return formatMoney({ amount, currency });
}

/**
 * Refunds per line item (PAGE-SPECS.md §3.5). The preview prices the
 * selection exactly as the server does — each line's total is shared out
 * cumulatively — and a confirmation step names the amount and the card
 * before anything is sent. Never optimistic: the order reloads afterwards.
 *
 * One `Idempotency-Key` per opened dialog (the parent re-keys the dialog on
 * every open), reused on every retry of the same refund. It is replaced only
 * when the operator edits the refund after a failed attempt — the server
 * refuses a key reused for a different request.
 */
export function RefundDialog({
  order,
  open,
  onOpenChange,
  onRefunded,
}: {
  order: Order;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRefunded: (refund: Refund) => void;
}) {
  const ledger = refundLedger(order);
  const lines = order.lines.map((line) => ({
    line,
    left: refundableUnits(line, ledger),
    restockable: Math.min(refundableUnits(line, ledger), unshippedUnits(line, ledger)),
  }));
  const currency = order.currency;

  const [picks, setPicks] = useState<Record<string, LinePick>>({});
  const [includeShipping, setIncludeShipping] = useState(false);
  const [extra, setExtra] = useState("");
  const [reason, setReason] = useState<Reason>("requested_by_customer");
  const [note, setNote] = useState("");
  const [step, setStep] = useState<"form" | "confirm" | "pending">("form");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attempt, setAttempt] = useState<{ key: string; body: string }>(() => ({
    key: crypto.randomUUID(),
    body: "",
  }));

  function pickFor(id: string): LinePick {
    return picks[id] ?? { selected: false, quantity: "", restock: false };
  }

  function update(id: string, change: Partial<LinePick>) {
    setPicks((current) => ({ ...current, [id]: { ...pickFor(id), ...change } }));
  }

  const extraMinor = extra.trim() ? toMinor(extra) : 0;
  const selection: RefundSelection = {
    lines: lines.flatMap(({ line }) => {
      const pick = pickFor(line.id);
      const quantity = Number(pick.quantity);
      return pick.selected && Number.isInteger(quantity) && quantity > 0
        ? [{ id: line.id, quantity }]
        : [];
    }),
    includeShipping,
    extra: extraMinor ?? 0,
  };
  const preview = previewRefund(order, selection);

  function validate(): boolean {
    const found: Record<string, string> = {};
    for (const { line, left, restockable } of lines) {
      const pick = pickFor(line.id);
      if (!pick.selected) continue;
      const quantity = Number(pick.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > left) {
        found[line.id] = `Enter 1 to ${String(left)}.`;
      } else if (pick.restock && quantity > restockable) {
        found[line.id] =
          restockable === 0
            ? "These units have shipped — restock them through a return."
            : `Only ${String(restockable)} unshipped ${restockable === 1 ? "unit" : "units"} can be restocked.`;
      }
    }
    if (extraMinor === null) found["extra"] = "Enter an amount like 5.00.";
    setErrors(found);
    if (Object.keys(found).length > 0) return false;
    if (preview.total <= 0) {
      setError("Choose items, shipping or an extra amount to refund.");
      return false;
    }
    if (preview.exceeds) {
      setError(`At most ${money(preview.refundable, currency)} can still be refunded.`);
      return false;
    }
    setError(null);
    return true;
  }

  async function send() {
    const body = {
      lines: lines.flatMap(({ line }) => {
        const pick = pickFor(line.id);
        const quantity = Number(pick.quantity);
        return pick.selected && quantity > 0
          ? [{ order_item_id: line.id, quantity, restock: pick.restock }]
          : [];
      }),
      include_shipping: includeShipping,
      extra_amount: extraMinor ?? 0,
      reason,
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    const serialised = JSON.stringify(body);
    // Same request: same key. A different request after a failure: a new key.
    const key =
      attempt.body === "" || attempt.body === serialised ? attempt.key : crypto.randomUUID();
    setAttempt({ key, body: serialised });
    setSending(true);
    setError(null);
    const outcome = await callApi((client) =>
      client.POST("/api/v1/admin/orders/{order_id}/refunds", {
        params: { path: { order_id: order.id } },
        body,
        headers: { "Idempotency-Key": key },
      }),
    );
    setSending(false);
    if (!outcome.ok) {
      const slug = problemSlug(outcome.problem);
      const fields = fieldErrors(outcome.problem);
      const perLine: Record<string, string> = {};
      for (const [field, message] of Object.entries(fields)) {
        if (field.startsWith("lines.")) perLine[field.slice("lines.".length)] = message;
      }
      setErrors(perLine);
      if (slug === "refund-exceeds-capture" || slug === "quantity-exceeded") {
        setError(fields["amount"] ?? outcome.problem.detail ?? outcome.problem.title);
        setStep("form"); // back to the form, where the problem can be fixed
      } else if (outcome.problem.status === 0) {
        setError(
          "We could not reach the store, so we do not know whether the refund went through. " +
            "Try again — the same request will not refund twice.",
        );
      } else {
        setError(outcome.problem.detail ?? outcome.problem.title);
      }
      return;
    }
    const refund = outcome.data;
    onRefunded(refund);
    if (refund.status === "pending") {
      setStep("pending");
    } else if (refund.status === "failed") {
      notify.error(
        `The provider declined the refund${refund.last_error ? `: ${refund.last_error}` : "."}`,
      );
      onOpenChange(false);
    } else {
      notify.success(`Refunded ${formatMoney(refund.amount)} to ${paymentLabel(order)}`);
      onOpenChange(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!sending) onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        {step === "pending" && (
          <>
            <DialogHeader>
              <DialogTitle>Refund recorded</DialogTitle>
              <DialogDescription>
                The payment provider has not confirmed it yet. It will be retried automatically, and
                the order’s refund history shows its status. Do not issue it again.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                Done
              </Button>
            </DialogFooter>
          </>
        )}

        {step === "confirm" && (
          <>
            <DialogHeader>
              <DialogTitle>
                Refund {money(preview.total, currency)} to {paymentLabel(order)}?
              </DialogTitle>
              <DialogDescription>
                This sends money back to the customer and cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <PreviewTable preview={preview} currency={currency} />
            {selection.lines.some((entry) => pickFor(entry.id).restock) && (
              <p className="text-sm">Restocked units go back into inventory and will not ship.</p>
            )}
            {error && <FormAlert title={error} />}
            <DialogFooter>
              <Button
                variant="outline"
                disabled={sending}
                onClick={() => {
                  setError(null);
                  setStep("form");
                }}
              >
                Back
              </Button>
              <Button
                variant="danger"
                loading={sending}
                onClick={() => {
                  void send();
                }}
              >
                Refund {money(preview.total, currency)}
              </Button>
            </DialogFooter>
          </>
        )}

        {step === "form" && (
          <form
            noValidate
            className="flex flex-col gap-4"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              if (validate()) setStep("confirm");
            }}
          >
            <DialogHeader>
              <DialogTitle>Refund</DialogTitle>
              <DialogDescription>
                Up to {money(order.refundable.amount, currency)} can still be refunded to{" "}
                {paymentLabel(order)}.
              </DialogDescription>
            </DialogHeader>

            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium">Items</legend>
              {lines.map(({ line, left, restockable }) => {
                const pick = pickFor(line.id);
                const ids = {
                  select: `refund-${line.id}`,
                  quantity: `refund-qty-${line.id}`,
                  restock: `refund-restock-${line.id}`,
                  error: `refund-${line.id}-error`,
                };
                const done = left === 0;
                return (
                  <div
                    key={line.id}
                    className={cn(
                      "border-border-subtle flex flex-wrap items-center gap-3 rounded-md border p-2",
                      done && "opacity-60",
                    )}
                  >
                    <label
                      htmlFor={ids.select}
                      className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-3"
                    >
                      <Checkbox
                        id={ids.select}
                        disabled={done}
                        checked={pick.selected}
                        onCheckedChange={(checked) => {
                          const on = checked === true;
                          update(line.id, {
                            selected: on,
                            quantity: on && !pick.quantity ? String(left) : pick.quantity,
                          });
                        }}
                      />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{line.product_title}</span>
                        <span className="text-text-secondary block truncate text-xs">
                          {[line.variant_title, line.sku].filter(Boolean).join(" · ")} ·{" "}
                          {formatMoney(line.total)} for {line.quantity} ·{" "}
                          {done ? "fully refunded" : `${String(left)} refundable`}
                        </span>
                      </span>
                    </label>
                    <div className="flex items-center gap-2">
                      <label htmlFor={ids.quantity} className="text-sm">
                        Qty
                      </label>
                      <Input
                        id={ids.quantity}
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={left}
                        className="w-20"
                        disabled={!pick.selected}
                        value={pick.quantity}
                        aria-invalid={errors[line.id] ? true : undefined}
                        aria-describedby={errors[line.id] ? ids.error : undefined}
                        onChange={(event) => {
                          update(line.id, { quantity: event.target.value });
                        }}
                      />
                    </div>
                    <label
                      htmlFor={ids.restock}
                      className={cn(
                        "flex min-h-11 items-center gap-2 text-sm",
                        restockable === 0 ? "cursor-not-allowed" : "cursor-pointer",
                      )}
                      title={
                        restockable === 0
                          ? "Shipped units come back to stock through a return."
                          : undefined
                      }
                    >
                      <Checkbox
                        id={ids.restock}
                        disabled={!pick.selected || restockable === 0}
                        checked={pick.restock}
                        onCheckedChange={(checked) => {
                          update(line.id, { restock: checked === true });
                        }}
                      />
                      Restock
                      {restockable > 0 && restockable < left && (
                        <span className="text-text-tertiary">(max {restockable})</span>
                      )}
                    </label>
                    <div className="basis-full empty:hidden">
                      <FieldError id={ids.error} message={errors[line.id]} />
                    </div>
                  </div>
                );
              })}
            </fieldset>

            <label
              htmlFor="refund-shipping"
              className="flex min-h-11 cursor-pointer items-center gap-3 text-sm"
            >
              <Checkbox
                id="refund-shipping"
                checked={includeShipping}
                onCheckedChange={(checked) => {
                  setIncludeShipping(checked === true);
                }}
              />
              Refund shipping
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label={`Extra amount (${currency})`}
                optional
                hint="Goodwill, on top of any items."
                inputMode="decimal"
                placeholder="0.00"
                value={extra}
                error={errors["extra"]}
                onChange={(event) => {
                  setExtra(event.target.value);
                }}
              />
              <NativeSelect
                label="Reason"
                options={REASONS}
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value as Reason);
                }}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="refund-note" className="text-sm font-medium">
                Note <span className="text-text-tertiary font-normal">(optional, staff only)</span>
              </label>
              <textarea
                id="refund-note"
                rows={2}
                maxLength={2000}
                value={note}
                onChange={(event) => {
                  setNote(event.target.value);
                }}
                className="border-border-default bg-surface-raised focus-visible:border-border-focus focus-visible:ring-ring/50 rounded-md border px-3 py-2 text-base outline-none focus-visible:ring-[3px]"
              />
            </div>

            <div aria-live="polite">
              <PreviewTable preview={preview} currency={currency} />
              {preview.exceeds && (
                <p className="text-danger mt-2 text-sm">
                  That is more than the {money(preview.refundable, currency)} left to refund.
                </p>
              )}
            </div>

            {error && <FormAlert title={error} />}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={preview.total <= 0 || preview.exceeds}>
                Review refund
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PreviewTable({
  preview,
  currency,
}: {
  preview: ReturnType<typeof previewRefund>;
  currency: string;
}) {
  return (
    <dl className="bg-surface-sunken grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 rounded-md p-3 text-sm tabular-nums">
      <dt>Items</dt>
      <dd className="text-right">{money(preview.lines, currency)}</dd>
      {preview.shipping > 0 && (
        <>
          <dt>
            Shipping <span className="text-text-tertiary">(estimate)</span>
          </dt>
          <dd className="text-right">{money(preview.shipping, currency)}</dd>
        </>
      )}
      {preview.extra > 0 && (
        <>
          <dt>Extra</dt>
          <dd className="text-right">{money(preview.extra, currency)}</dd>
        </>
      )}
      <dt className="border-border-subtle mt-1 border-t pt-1 font-semibold">Refund total</dt>
      <dd
        className={cn(
          "border-border-subtle mt-1 border-t pt-1 text-right font-semibold",
          preview.exceeds && "text-danger",
        )}
      >
        {money(preview.total, currency)}
      </dd>
      <dt className="text-text-secondary">Left to refund on this payment</dt>
      <dd className="text-text-secondary text-right">{money(preview.refundable, currency)}</dd>
    </dl>
  );
}
