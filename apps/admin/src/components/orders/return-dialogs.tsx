"use client";

import type { Schema } from "@velo/api-client";
import { useState, type FormEvent } from "react";

import { FieldError, FormAlert } from "@/components/forms/fields";
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

import { NativeSelect } from "./native-select";

type Return = Schema<"ReturnView">;
type Received = Schema<"ReceivedLineIn">;
type Condition = Received["condition"];

const CONDITIONS: { value: Condition | ""; label: string }[] = [
  { value: "", label: "Choose a condition" },
  { value: "new", label: "New — unworn, tags on" },
  { value: "opened", label: "Opened — resellable after a check" },
  { value: "damaged", label: "Damaged — cannot be resold" },
];

function NoteField({
  id,
  label,
  value,
  onChange,
  error,
  required = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  required?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
        {!required && <span className="text-text-tertiary font-normal"> (optional)</span>}
      </label>
      <textarea
        id={id}
        rows={3}
        maxLength={2000}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className="border-border-default bg-surface-raised focus-visible:border-border-focus focus-visible:ring-ring/50 aria-invalid:border-danger rounded-md border px-3 py-2 text-base outline-none focus-visible:ring-[3px]"
      />
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

/** Rejecting tells the customer why — the staff note is required. */
export function RejectDialog({
  rma,
  onClose,
  onReject,
}: {
  rma: string;
  onClose: () => void;
  onReject: (note: string) => Promise<string | null>;
}) {
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!note.trim()) {
      setNoteError("Say why, so the customer and your team know.");
      return;
    }
    setNoteError(undefined);
    setPending(true);
    const failure = await onReject(note.trim());
    setPending(false);
    if (failure) setError(failure);
    else onClose();
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
            <DialogTitle>Reject return {rma}?</DialogTitle>
            <DialogDescription>The customer is told it was not accepted.</DialogDescription>
          </DialogHeader>
          <NoteField
            id="reject-note"
            label="Reason"
            required
            value={note}
            onChange={setNote}
            error={noteError}
          />
          {error && <FormAlert title={error} />}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" loading={pending}>
              Reject return
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface Inspection {
  condition: Condition | "";
  restock: boolean;
}

/**
 * Receiving needs a decision for every line: its condition, and whether it
 * goes back into stock. Restock defaults off — a returned item is not back in
 * stock until someone has looked at it (PAGE-SPECS.md §3.5).
 */
export function ReceiveDialog({
  returned,
  lineTitle,
  loading,
  onClose,
  onReceive,
}: {
  returned: Return;
  lineTitle: (orderItemId: string) => string;
  loading: boolean;
  onClose: () => void;
  onReceive: (lines: Received[], note: string) => Promise<string | null>;
}) {
  const [inspections, setInspections] = useState<Record<string, Inspection>>({});
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function inspectionFor(id: string): Inspection {
    return inspections[id] ?? { condition: "", restock: false };
  }

  function update(id: string, change: Partial<Inspection>) {
    setInspections((current) => ({ ...current, [id]: { ...inspectionFor(id), ...change } }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found: Record<string, string> = {};
    const lines: Received[] = [];
    for (const line of returned.lines) {
      const inspection = inspectionFor(line.order_item_id);
      if (!inspection.condition) {
        found[line.order_item_id] = "Choose the condition it arrived in.";
        continue;
      }
      lines.push({
        order_item_id: line.order_item_id,
        condition: inspection.condition,
        restock: inspection.restock,
      });
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setPending(true);
    setError(null);
    const failure = await onReceive(lines, note.trim());
    setPending(false);
    if (failure) setError(failure);
    else onClose();
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <DialogHeader>
            <DialogTitle>Receive return {returned.rma_number}</DialogTitle>
            <DialogDescription>
              Inspect each item. Only what you mark to restock goes back into inventory.
            </DialogDescription>
          </DialogHeader>
          {loading && <p className="text-text-secondary text-sm">Loading item names…</p>}
          <fieldset className="flex flex-col gap-3">
            <legend className="sr-only">Items</legend>
            {returned.lines.map((line) => {
              const inspection = inspectionFor(line.order_item_id);
              const restockId = `receive-restock-${line.order_item_id}`;
              return (
                <div
                  key={line.order_item_id}
                  className="border-border-subtle flex flex-col gap-2 rounded-md border p-3"
                >
                  <p className="font-medium">
                    {line.quantity} × {lineTitle(line.order_item_id)}
                  </p>
                  <NativeSelect
                    label="Condition"
                    options={CONDITIONS}
                    value={inspection.condition}
                    aria-invalid={errors[line.order_item_id] ? true : undefined}
                    onChange={(event) => {
                      const condition = event.target.value as Condition | "";
                      update(line.order_item_id, {
                        condition,
                        // Damaged goods are never restocked by accident.
                        ...(condition === "damaged" ? { restock: false } : {}),
                      });
                    }}
                  />
                  <FieldError
                    id={`receive-${line.order_item_id}-error`}
                    message={errors[line.order_item_id]}
                  />
                  <label
                    htmlFor={restockId}
                    className="flex min-h-11 cursor-pointer items-center gap-3 text-sm"
                  >
                    <Checkbox
                      id={restockId}
                      checked={inspection.restock}
                      disabled={inspection.condition === "damaged"}
                      onCheckedChange={(checked) => {
                        update(line.order_item_id, { restock: checked === true });
                      }}
                    />
                    Put {line.quantity === 1 ? "it" : "them"} back in stock
                  </label>
                </div>
              );
            })}
          </fieldset>
          <NoteField id="receive-note" label="Staff note" value={note} onChange={setNote} />
          {error && <FormAlert title={error} />}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Mark received
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
