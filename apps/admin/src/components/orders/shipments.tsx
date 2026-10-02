"use client";

import type { Schema } from "@velo/api-client";
import { ExternalLinkIcon, PencilIcon, PrinterIcon, TruckIcon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { FormAlert, TextField } from "@/components/forms/fields";
import { formatDateTime } from "@/components/page";
import { IfCan } from "@/components/shell/me-context";
import { StatusBadge } from "@/components/status";
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

import { packingSlipUrl } from "./fulfil-dialog";
import { NativeSelect } from "./native-select";
import { CARRIERS, PARCEL_NEXT, carrierLabel } from "./order-math";

type Order = Schema<"AdminOrderView">;
type Shipment = Schema<"ShipmentView">;
type ShipmentStatus = NonNullable<Schema<"UpdateShipment">["status"]>;

const PARCEL_LABELS: Record<string, string> = {
  in_transit: "In transit",
  delivered: "Delivered",
  failed: "Delivery failed",
  cancelled: "Cancelled",
};

/** Every parcel on the order: what is in it, where it is, and its paperwork. */
export function Shipments({
  order,
  onUpdated,
}: {
  order: Order;
  onUpdated: (parcel: Shipment) => void;
}) {
  const [editing, setEditing] = useState<Shipment | null>(null);
  const [editKey, setEditKey] = useState(0);
  const byId = new Map(order.lines.map((line) => [line.id, line]));

  if (order.shipments.length === 0) {
    return <p className="text-text-secondary text-sm">Nothing has shipped yet.</p>;
  }

  return (
    <>
      <ul className="flex flex-col gap-3">
        {order.shipments.map((parcel, index) => (
          <li key={parcel.id} className="border-border-subtle rounded-md border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-2 font-medium">
                <TruckIcon className="size-4" aria-hidden />
                Parcel {index + 1}
                <StatusBadge status={parcel.status} />
              </p>
              <div className="flex flex-wrap gap-2">
                <IfCan permission="orders:fulfil">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setEditKey((key) => key + 1);
                      setEditing(parcel);
                    }}
                  >
                    <PencilIcon aria-hidden />
                    Update
                  </Button>
                </IfCan>
                <Button asChild variant="outline" size="sm">
                  <a
                    href={packingSlipUrl(order.id, parcel.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <PrinterIcon aria-hidden />
                    Packing slip
                  </a>
                </Button>
              </div>
            </div>
            <dl className="text-text-secondary mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
              <dt>Carrier</dt>
              <dd>{parcel.carrier ? carrierLabel(parcel.carrier) : "—"}</dd>
              <dt>Tracking</dt>
              <dd>
                {parcel.tracking_url ? (
                  <a
                    href={parcel.tracking_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary inline-flex items-center gap-1 font-mono underline underline-offset-4"
                  >
                    {parcel.tracking_number ?? "Track"}
                    <ExternalLinkIcon className="size-3" aria-hidden />
                    <span className="sr-only">(opens in a new tab)</span>
                  </a>
                ) : (
                  <span className="font-mono">{parcel.tracking_number ?? "—"}</span>
                )}
              </dd>
              <dt>Shipped</dt>
              <dd>{formatDateTime(parcel.shipped_at)}</dd>
              {parcel.delivered_at && (
                <>
                  <dt>Delivered</dt>
                  <dd>{formatDateTime(parcel.delivered_at)}</dd>
                </>
              )}
            </dl>
            <ul className="mt-2 text-sm">
              {parcel.lines.map((entry) => {
                const line = byId.get(String(entry["order_item_id"]));
                return (
                  <li key={String(entry["order_item_id"])}>
                    {Number(entry["quantity"])} × {line?.product_title ?? "Item"}
                    {line?.variant_title && (
                      <span className="text-text-secondary"> · {line.variant_title}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
      {editing && (
        <UpdateParcelDialog
          key={editKey}
          parcel={editing}
          onClose={() => {
            setEditing(null);
          }}
          onUpdated={(parcel) => {
            setEditing(null);
            onUpdated(parcel);
          }}
        />
      )}
    </>
  );
}

function UpdateParcelDialog({
  parcel,
  onClose,
  onUpdated,
}: {
  parcel: Shipment;
  onClose: () => void;
  onUpdated: (parcel: Shipment) => void;
}) {
  const next = PARCEL_NEXT[parcel.status] ?? [];
  const known = CARRIERS.some((entry) => entry.value === parcel.carrier);
  const [status, setStatus] = useState("");
  const [carrier, setCarrier] = useState(parcel.carrier ?? "");
  const [tracking, setTracking] = useState(parcel.tracking_number ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const carrierOptions = [
    { value: "", label: "No carrier" },
    ...CARRIERS,
    ...(parcel.carrier && !known ? [{ value: parcel.carrier, label: parcel.carrier }] : []),
  ];

  async function submit(event: FormEvent) {
    event.preventDefault();
    const body: Schema<"UpdateShipment"> = {};
    if (status) body.status = status as ShipmentStatus;
    if (carrier && carrier !== (parcel.carrier ?? "")) body.carrier = carrier;
    if (tracking.trim() && tracking.trim() !== (parcel.tracking_number ?? "")) {
      body.tracking_number = tracking.trim();
    }
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    setPending(true);
    setError(null);
    const outcome = await callApi((client) =>
      client.PATCH("/api/v1/admin/fulfilments/{fulfilment_id}", {
        params: { path: { fulfilment_id: parcel.id } },
        body,
      }),
    );
    setPending(false);
    if (!outcome.ok) {
      setErrors(fieldErrors(outcome.problem));
      setError(outcome.problem.detail ?? outcome.problem.title);
      return;
    }
    notify.success("Parcel updated");
    onUpdated(outcome.data);
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <DialogHeader>
            <DialogTitle>Update parcel</DialogTitle>
            <DialogDescription>
              Currently {PARCEL_LABELS[parcel.status]?.toLowerCase() ?? parcel.status}. Changing the
              carrier or number rebuilds the tracking link.
            </DialogDescription>
          </DialogHeader>
          {next.length > 0 ? (
            <NativeSelect
              label="Status"
              value={status}
              options={[
                { value: "", label: "Keep the current status" },
                ...next.map((value) => ({
                  value,
                  label: `Mark ${PARCEL_LABELS[value]?.toLowerCase() ?? value}`,
                })),
              ]}
              onChange={(event) => {
                setStatus(event.target.value);
              }}
            />
          ) : (
            <p className="text-text-secondary text-sm">
              This parcel’s status is final; only its tracking can change.
            </p>
          )}
          <NativeSelect
            label="Carrier"
            value={carrier}
            options={carrierOptions}
            onChange={(event) => {
              setCarrier(event.target.value);
            }}
          />
          <TextField
            label="Tracking number"
            value={tracking}
            maxLength={100}
            autoComplete="off"
            error={errors["tracking_number"]}
            onChange={(event) => {
              setTracking(event.target.value);
            }}
          />
          {error && <FormAlert title={error} />}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
