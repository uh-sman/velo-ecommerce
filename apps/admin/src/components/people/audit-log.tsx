"use client";

import type { Schema } from "@velo/api-client";
import { useState, type ChangeEvent, type FormEvent } from "react";

import { TextField } from "@/components/forms/fields";
import { EmptyState, ErrorState, Section, formatDateTime } from "@/components/page";
import { Button } from "@/components/ui/button";
import { callApi } from "@/lib/api-browser";

import { LoadMore, TableSkeleton, useCursorList } from "./shared";

type Entry = Schema<"AuditView">;

interface Filters {
  actor: string;
  entityType: string;
  entityId: string;
  action: string;
  since: string; // yyyy-mm-dd, local
  until: string; // yyyy-mm-dd, local, inclusive
}

const EMPTY: Filters = {
  actor: "",
  entityType: "",
  entityId: "",
  action: "",
  since: "",
  until: "",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The start of a local day, as an instant; `nextDay` for an inclusive "until". */
function dayStart(value: string, nextDay = false): string | null {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day + (nextDay ? 1 : 0)).toISOString();
}

function scalar(value: unknown): string {
  if (value === null || value === undefined || value === "") return "empty";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function isDiff(value: unknown): value is { from: unknown; to: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "from" in value &&
    "to" in value &&
    Object.keys(value).length === 2
  );
}

/** `{field: {from, to}}` as "field: from → to"; anything else as compact JSON. */
export function Changes({ changes }: { changes: Entry["changes"] }) {
  if (!changes || Object.keys(changes).length === 0) {
    return <span className="text-text-tertiary">—</span>;
  }
  return (
    <ul className="flex flex-col gap-0.5 text-xs">
      {Object.entries(changes).map(([field, value]) => (
        <li key={field} className="break-words">
          <span className="font-medium">{field.replace(/_/g, " ")}</span>
          {": "}
          {isDiff(value) ? (
            <>
              <span className="text-text-secondary line-through decoration-1">
                {scalar(value.from)}
              </span>
              <span aria-label="changed to"> → </span>
              <span>{scalar(value.to)}</span>
            </>
          ) : (
            <code className="font-mono">{scalar(value)}</code>
          )}
        </li>
      ))}
    </ul>
  );
}

export function AuditLog() {
  const [form, setForm] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [idError, setIdError] = useState<string | undefined>(undefined);

  const list = useCursorList<Entry>(
    (cursor) =>
      callApi((client) =>
        client.GET("/api/v1/admin/audit-log", {
          params: {
            query: {
              actor: applied.actor || null,
              entity_type: applied.entityType || null,
              entity_id: applied.entityId || null,
              action: applied.action || null,
              since: dayStart(applied.since),
              until: dayStart(applied.until, true),
              cursor,
              limit: 50,
            },
          },
        }),
      ),
    JSON.stringify(applied),
  );

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const entityId = form.entityId.trim();
    if (entityId && !UUID.test(entityId)) {
      setIdError("An entity ID looks like 3f2a…-…, 36 characters.");
      return;
    }
    setIdError(undefined);
    setApplied({
      actor: form.actor.trim(),
      entityType: form.entityType.trim(),
      entityId,
      action: form.action.trim(),
      since: form.since,
      until: form.until,
    });
  }

  function field(key: keyof Filters) {
    return {
      value: form[key],
      onChange: (event: ChangeEvent<HTMLInputElement>) => {
        setForm((current) => ({ ...current, [key]: event.target.value }));
      },
    };
  }

  const filtered = JSON.stringify(applied) !== JSON.stringify(EMPTY);

  return (
    <div className="flex flex-col gap-4">
      <Section title="Filter">
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <TextField label="Who" placeholder="name@store.com" type="email" {...field("actor")} />
            <TextField
              label="Action"
              placeholder="discount. or order.refunded"
              hint="Exact, or a prefix ending in “.”."
              {...field("action")}
            />
            <TextField
              label="Entity type"
              placeholder="order, discount, user…"
              {...field("entityType")}
            />
            <TextField
              label="Entity ID"
              error={idError}
              spellCheck={false}
              {...field("entityId")}
            />
            <TextField label="From" type="date" {...field("since")} />
            <TextField label="To" type="date" hint="Includes the whole day." {...field("until")} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit">Apply filters</Button>
            {filtered && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setForm(EMPTY);
                  setApplied(EMPTY);
                  setIdError(undefined);
                }}
              >
                Clear
              </Button>
            )}
          </div>
        </form>
      </Section>

      {list.state === "loading" && <TableSkeleton label="Loading the audit log" />}
      {list.state === "error" && (
        <ErrorState title={list.error ?? "We could not load the audit log."} onRetry={list.retry} />
      )}
      {list.state === "ready" && list.items.length === 0 && (
        <EmptyState title={filtered ? "Nothing matches these filters" : "Nothing recorded yet"}>
          {filtered
            ? "Widen the dates or use an action prefix such as “order.”."
            : "Changes staff make to orders, products, discounts and settings appear here."}
        </EmptyState>
      )}
      {list.state === "ready" && list.items.length > 0 && (
        <>
          <div className="border-border-subtle overflow-x-auto rounded-lg border">
            <table aria-label="Audit log" className="w-full min-w-[48rem] text-left text-sm">
              <thead>
                <tr>
                  {["When", "Who", "Action", "Entity", "Changes"].map((heading) => (
                    <th
                      key={heading}
                      scope="col"
                      className="bg-surface-sunken text-text-secondary px-3 py-2 text-xs font-medium uppercase tracking-wide"
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.items.map((entry) => (
                  <tr key={entry.id} className="align-top">
                    <td className="border-border-subtle whitespace-nowrap border-t px-3 py-2.5">
                      <time dateTime={entry.created_at}>{formatDateTime(entry.created_at)}</time>
                    </td>
                    <td className="border-border-subtle break-all border-t px-3 py-2.5">
                      {entry.actor_email ?? <span className="text-text-secondary">System</span>}
                      {entry.ip_address && (
                        <span className="text-text-tertiary block text-xs">{entry.ip_address}</span>
                      )}
                    </td>
                    <td className="border-border-subtle border-t px-3 py-2.5">
                      <code className="font-mono text-xs">{entry.action}</code>
                    </td>
                    <td className="border-border-subtle border-t px-3 py-2.5">
                      <span className="block">{entry.entity_type}</span>
                      {entry.entity_id && (
                        <button
                          type="button"
                          className="text-text-secondary inline-flex min-h-11 items-center font-mono text-xs underline-offset-2 hover:underline"
                          title="Show only this entity"
                          onClick={() => {
                            const next = {
                              ...EMPTY,
                              entityType: entry.entity_type,
                              entityId: entry.entity_id ?? "",
                            };
                            setForm(next);
                            setApplied(next);
                          }}
                        >
                          {entry.entity_id.slice(0, 8)}…
                          <span className="sr-only"> — show only this entity</span>
                        </button>
                      )}
                    </td>
                    <td className="border-border-subtle border-t px-3 py-2.5">
                      <Changes changes={entry.changes} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <LoadMore
            hasMore={list.hasMore}
            loading={list.loadingMore}
            error={list.moreError}
            onLoadMore={list.loadMore}
            shown={list.items.length}
            total={list.total}
            noun="entries"
          />
        </>
      )}
    </div>
  );
}
