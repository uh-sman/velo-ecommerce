"use client";

import type { Schema } from "@velo/api-client";
import { useState } from "react";

import { useCan } from "@/components/shell/me-context";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ui/sonner";
import { callApi } from "@/lib/api-browser";

type Order = Schema<"AdminOrderView">;

/**
 * The staff-only note (`PATCH /admin/orders/{id}/notes`). Saving is
 * optimistic: the note shows at once and comes back as it was on failure.
 */
export function OrderNotes({
  order,
  onSaved,
  onChange,
}: {
  order: Order;
  /** The server's order after a save. */
  onSaved: (order: Order) => void;
  /** Optimistic local edit (and its rollback). */
  onChange: (note: string | null) => void;
}) {
  const canEdit = useCan("orders:fulfil");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(order.internal_note ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    const previous = order.internal_note;
    const next = draft.trim() || null;
    setSaving(true);
    onChange(next);
    setEditing(false);
    const outcome = await callApi((client) =>
      client.PATCH("/api/v1/admin/orders/{order_id}/notes", {
        params: { path: { order_id: order.id } },
        body: { internal_note: next },
      }),
    );
    setSaving(false);
    if (outcome.ok) {
      onSaved(outcome.data);
      notify.success(next ? "Note saved" : "Note removed");
    } else {
      onChange(previous);
      setDraft(previous ?? "");
      setEditing(true);
      notify.error(`The note was not saved. ${outcome.problem.title}`);
    }
  }

  return (
    <div className="flex flex-col gap-3 text-sm">
      {order.customer_note && (
        <div>
          <p className="text-text-secondary text-xs font-medium uppercase tracking-wide">
            From the customer
          </p>
          <p className="whitespace-pre-wrap">{order.customer_note}</p>
        </div>
      )}
      <div>
        <p className="text-text-secondary text-xs font-medium uppercase tracking-wide">
          Internal note
        </p>
        {editing ? (
          <div className="mt-1 flex flex-col gap-2">
            <label htmlFor="internal-note" className="sr-only">
              Internal note
            </label>
            <textarea
              id="internal-note"
              rows={4}
              maxLength={2000}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
              }}
              className="border-border-default bg-surface-raised focus-visible:border-border-focus focus-visible:ring-ring/50 rounded-md border px-3 py-2 text-base outline-none focus-visible:ring-[3px]"
            />
            <p className="text-text-tertiary text-xs">
              Only staff see this. Saved to the timeline.
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                loading={saving}
                onClick={() => {
                  void save();
                }}
              >
                Save note
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraft(order.internal_note ?? "");
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="whitespace-pre-wrap">
              {order.internal_note ?? <span className="text-text-secondary">No note.</span>}
            </p>
            {canEdit && (
              <Button
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={() => {
                  setDraft(order.internal_note ?? "");
                  setEditing(true);
                }}
              >
                {order.internal_note ? "Edit note" : "Add note"}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
