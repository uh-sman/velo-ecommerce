"use client";

import type { Schema } from "@velo/api-client";
import { PrinterIcon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { FieldError, FormAlert, TextField } from "@/components/forms/fields";
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
import { callApi, fieldErrors } from "@/lib/api-browser";
import { apiUrl } from "@/lib/utils";

import { NativeSelect } from "./native-select";
import { CARRIERS, refundLedger, unshippedUnits } from "./order-math";

type Order = Schema<"AdminOrderView">;
type Shipment = Schema<"ShipmentView">;

interface Pick {
  selected: boolean;
  quantity: string;
}

const CARRIER_OPTIONS = [
  { value: "", label: "No carrier" },
  ...CARRIERS,
  { value: "__other", label: "Other…" },
];

export function packingSlipUrl(orderId: string, fulfilmentId?: string): string {
  const query = fulfilmentId ? `?fulfilment_id=${encodeURIComponent(fulfilmentId)}` : "";
  return apiUrl(`/api/v1/admin/orders/${orderId}/packing-slip${query}`);
}

/**
 * Partial fulfilment is first-class (PAGE-SPECS.md §3.5): pick lines and
 * quantities (default: everything left to ship), a carrier and tracking
 * number, and whether the customer hears about it. Then offer the parcel's
 * packing slip. The parent re-keys it on every open, so each opening starts fresh.
 */
export function FulfilDialog({
  order,
  open,
  onOpenChange,
  onFulfilled,
}: {
  order: Order;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFulfilled: (parcel: Shipment) => void;
}) {
  const ledger = refundLedger(order);
  const shippable = order.lines
    .map((line) => ({ line, left: unshippedUnits(line, ledger) }))
    .filter((entry) => entry.left > 0);

  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [carrier, setCarrier] = useState("");
  const [otherCarrier, setOtherCarrier] = useState("");
  const [tracking, setTracking] = useState("");
  const [notifyCustomer, setNotifyCustomer] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<Shipment | null>(null);

  function pickFor(id: string, left: number): Pick {
    return picks[id] ?? { selected: true, quantity: String(left) };
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const lineErrors: Record<string, string> = {};
    const lines: { order_item_id: string; quantity: number }[] = [];
    for (const { line, left } of shippable) {
      const pick = pickFor(line.id, left);
      if (!pick.selected) continue;
      const quantity = Number(pick.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > left) {
        lineErrors[line.id] = `Enter 1 to ${String(left)}.`;
        continue;
      }
      lines.push({ order_item_id: line.id, quantity });
    }
    setErrors(lineErrors);
    if (Object.keys(lineErrors).length > 0) return;
    if (lines.length === 0) {
      setError("Choose at least one item to ship.");
      return;
    }
    const carrierValue = carrier === "__other" ? otherCarrier.trim() : carrier;
    setPending(true);
    const outcome = await callApi((client) =>
      client.POST("/api/v1/admin/orders/{order_id}/fulfilments", {
        params: { path: { order_id: order.id } },
        body: {
          lines,
          notify_customer: notifyCustomer,
          ...(carrierValue ? { carrier: carrierValue } : {}),
          ...(tracking.trim() ? { tracking_number: tracking.trim() } : {}),
        },
      }),
    );
    setPending(false);
    if (!outcome.ok) {
      const fields = fieldErrors(outcome.problem);
      const perLine: Record<string, string> = {};
      for (const [field, message] of Object.entries(fields)) {
        if (field.startsWith("lines.")) perLine[field.slice("lines.".length)] = message;
      }
      setErrors(perLine);
      setError(outcome.problem.detail ?? outcome.problem.title);
      return;
    }
    setCreated(outcome.data);
    notify.success(
      notifyCustomer ? "Parcel created — the customer has been emailed" : "Parcel created",
    );
    onFulfilled(outcome.data);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Parcel created</DialogTitle>
              <DialogDescription>
                {created.tracking_number
                  ? `Tracking ${created.tracking_number}.`
                  : "No tracking number yet — you can add one from the parcel later."}{" "}
                Print the packing slip to go in the box.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                Done
              </Button>
              <Button asChild>
                <a
                  href={packingSlipUrl(order.id, created.id)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <PrinterIcon aria-hidden />
                  Print packing slip
                </a>
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form
            onSubmit={(event) => {
              void submit(event);
            }}
            noValidate
            className="flex flex-col gap-4"
          >
            <DialogHeader>
              <DialogTitle>Fulfil items</DialogTitle>
              <DialogDescription>
                Choose what goes in this parcel. Everything left to ship is selected.
              </DialogDescription>
            </DialogHeader>

            {shippable.length === 0 ? (
              <p className="text-sm">Everything on this order has already shipped.</p>
            ) : (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 text-sm font-medium">Items</legend>
                {shippable.map(({ line, left }) => {
                  const pick = pickFor(line.id, left);
                  const checkboxId = `ship-${line.id}`;
                  const quantityId = `ship-qty-${line.id}`;
                  return (
                    <div
                      key={line.id}
                      className="border-border-subtle flex flex-wrap items-center gap-3 rounded-md border p-2"
                    >
                      <label
                        htmlFor={checkboxId}
                        className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-3"
                      >
                        <Checkbox
                          id={checkboxId}
                          checked={pick.selected}
                          onCheckedChange={(checked) => {
                            setPicks((current) => ({
                              ...current,
                              [line.id]: { ...pick, selected: checked === true },
                            }));
                          }}
                        />
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{line.product_title}</span>
                          <span className="text-text-secondary block truncate text-xs">
                            {[line.variant_title, line.sku].filter(Boolean).join(" · ")} · {left}{" "}
                            left to ship
                          </span>
                        </span>
                      </label>
                      <div className="flex items-center gap-2">
                        <label htmlFor={quantityId} className="text-sm">
                          Qty
                        </label>
                        <Input
                          id={quantityId}
                          type="number"
                          inputMode="numeric"
                          min={1}
                          max={left}
                          className="w-20"
                          disabled={!pick.selected}
                          value={pick.quantity}
                          aria-invalid={errors[line.id] ? true : undefined}
                          aria-describedby={errors[line.id] ? `${quantityId}-error` : undefined}
                          onChange={(event) => {
                            setPicks((current) => ({
                              ...current,
                              [line.id]: { ...pick, quantity: event.target.value },
                            }));
                          }}
                        />
                      </div>
                      <div className="basis-full empty:hidden">
                        <FieldError id={`${quantityId}-error`} message={errors[line.id]} />
                      </div>
                    </div>
                  );
                })}
              </fieldset>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <NativeSelect
                label="Carrier"
                options={CARRIER_OPTIONS}
                value={carrier}
                onChange={(event) => {
                  setCarrier(event.target.value);
                }}
              />
              {carrier === "__other" && (
                <TextField
                  label="Carrier name"
                  value={otherCarrier}
                  maxLength={100}
                  onChange={(event) => {
                    setOtherCarrier(event.target.value);
                  }}
                />
              )}
              <TextField
                label="Tracking number"
                optional
                value={tracking}
                maxLength={100}
                autoComplete="off"
                onChange={(event) => {
                  setTracking(event.target.value);
                }}
              />
            </div>

            <label
              htmlFor="fulfil-notify"
              className="flex min-h-11 cursor-pointer items-center gap-3 text-sm"
            >
              <Checkbox
                id="fulfil-notify"
                checked={notifyCustomer}
                onCheckedChange={(checked) => {
                  setNotifyCustomer(checked === true);
                }}
              />
              Email the customer that this parcel is on its way
            </label>

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
              <Button type="submit" loading={pending} disabled={shippable.length === 0}>
                Create parcel
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
