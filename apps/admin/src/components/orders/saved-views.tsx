"use client";

import type { Schema } from "@velo/api-client";
import { BookmarkIcon, ChevronDownIcon, Trash2Icon } from "lucide-react";
import { Popover } from "radix-ui";
import { useEffect, useState, type FormEvent } from "react";

import { FieldError } from "@/components/forms/fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { notify } from "@/components/ui/sonner";
import { callApi, fieldErrors } from "@/lib/api-browser";

import { filtersFromQuery, sameFilters, type OrderFilters } from "./order-filters";

type View = Schema<"ViewOut">;

/**
 * The operator's own saved filters (`/admin/saved-views`, scope `orders`):
 * apply one, save the current filters under a name, delete one. Deleting is
 * optimistic — a saved view is a bookmark, and it comes back on failure.
 */
export function SavedViews({
  current,
  onApply,
}: {
  current: OrderFilters;
  onApply: (filters: OrderFilters) => void;
}) {
  const [open, setOpen] = useState(false);
  const [views, setViews] = useState<View[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoadError(false);
    const outcome = await callApi((client) =>
      client.GET("/api/v1/admin/saved-views", { params: { query: { scope: "orders" } } }),
    );
    if (outcome.ok) setViews(outcome.data);
    else setLoadError(true);
  }

  useEffect(() => {
    void load();
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError("Give the view a name.");
      return;
    }
    setSaving(true);
    setNameError(undefined);
    const outcome = await callApi((client) =>
      client.POST("/api/v1/admin/saved-views", {
        body: { scope: "orders", name: trimmed, query: { ...current } },
      }),
    );
    setSaving(false);
    if (!outcome.ok) {
      setNameError(fieldErrors(outcome.problem)["name"] ?? outcome.problem.title);
      return;
    }
    setViews((list) => [...(list ?? []), outcome.data]);
    setName("");
    notify.success(`Saved “${outcome.data.name}”`);
  }

  async function remove(view: View) {
    const before = views;
    setViews((list) => list?.filter((entry) => entry.id !== view.id) ?? null);
    const outcome = await callApi((client) =>
      client.DELETE("/api/v1/admin/saved-views/{view_id}", {
        params: { path: { view_id: view.id } },
      }),
    );
    if (outcome.ok) {
      notify.success(`Deleted “${view.name}”`);
    } else {
      setViews(before);
      notify.error(`Could not delete “${view.name}”. ${outcome.problem.title}`);
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button variant="outline">
          <BookmarkIcon aria-hidden />
          Saved views
          <ChevronDownIcon aria-hidden />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="border-border-default bg-surface-raised z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-lg border p-3 shadow-lg outline-none"
        >
          <p className="text-sm font-semibold">My saved views</p>
          {views === null && !loadError && <p className="text-text-secondary text-sm">Loading…</p>}
          {loadError && (
            <p className="text-sm">
              Could not load your views.{" "}
              <Button
                variant="link"
                className="h-auto p-0"
                onClick={() => {
                  void load();
                }}
              >
                Try again
              </Button>
            </p>
          )}
          {views?.length === 0 && (
            <p className="text-text-secondary text-sm">
              None yet. Set some filters and save them below.
            </p>
          )}
          {views && views.length > 0 && (
            <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
              {views.map((view) => {
                const filters = filtersFromQuery(view.query);
                const active = sameFilters(filters, current);
                return (
                  <li key={view.id} className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      className="min-h-11 flex-1 justify-start truncate"
                      aria-current={active ? "true" : undefined}
                      onClick={() => {
                        onApply(filters);
                        setOpen(false);
                      }}
                    >
                      <span className="truncate">{view.name}</span>
                      {active && <span className="text-text-tertiary text-xs">(current)</span>}
                    </Button>
                    <Button
                      variant="ghost"
                      className="size-11 p-0"
                      aria-label={`Delete saved view ${view.name}`}
                      onClick={() => {
                        void remove(view);
                      }}
                    >
                      <Trash2Icon aria-hidden />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          <form
            onSubmit={(event) => {
              void save(event);
            }}
            className="border-border-subtle flex flex-col gap-1.5 border-t pt-3"
            noValidate
          >
            <label htmlFor="saved-view-name" className="text-sm font-medium">
              Save current filters as
            </label>
            <div className="flex gap-2">
              <Input
                id="saved-view-name"
                value={name}
                maxLength={60}
                placeholder="e.g. Big orders this week"
                aria-invalid={nameError ? true : undefined}
                aria-describedby={nameError ? "saved-view-name-error" : undefined}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
              <Button type="submit" loading={saving}>
                Save
              </Button>
            </div>
            <FieldError id="saved-view-name-error" message={nameError} />
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
