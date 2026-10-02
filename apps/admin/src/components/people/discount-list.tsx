"use client";

import type { Schema } from "@velo/api-client";
import { SearchIcon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Table,
  formatDate,
  td,
  th,
} from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { notify } from "@/components/ui/sonner";
import { callApi } from "@/lib/api-browser";
import { cn } from "@/lib/utils";

import { STATUS_LABEL, STATUS_TONE, valueLabel, type DiscountStatus } from "./discount-rules";
import { SelectField, TableSkeleton, problemMessage, useDebounced, useResource } from "./shared";

type Discount = Schema<"DiscountView">;

export function DiscountStatusBadge({ status }: { status: DiscountStatus }) {
  const tone = STATUS_TONE[status];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm px-2 py-0.5 text-xs font-medium",
        tone === "neutral" && "bg-surface-sunken text-text-secondary",
        tone === "info" && "bg-info/10 text-info",
        tone === "success" && "bg-success/10 text-success",
        tone === "warning" && "bg-warning/10 text-warning",
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

const STATUSES: (DiscountStatus | "")[] = [
  "",
  "active",
  "scheduled",
  "expired",
  "used_up",
  "inactive",
];

export function DiscountList() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<DiscountStatus | "">("");
  const q = useDebounced(query.trim());
  const { load, reload, mutate } = useResource(
    () =>
      callApi((client) =>
        client.GET("/api/v1/admin/discounts", {
          params: { query: { q: q || null, status: status || null } },
        }),
      ),
    `${q}|${status}`,
  );
  const [retiring, setRetiring] = useState<Discount | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="relative w-full max-w-sm">
          <label htmlFor="discount-search" className="sr-only">
            Search discounts by code or title
          </label>
          <SearchIcon
            className="text-text-tertiary pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2"
            aria-hidden
          />
          <Input
            id="discount-search"
            type="search"
            placeholder="Search by code or title"
            className="pl-9"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </div>
        <SelectField
          label="Status"
          hideLabel
          className="w-44"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as DiscountStatus | "");
          }}
        >
          {STATUSES.map((value) => (
            <option key={value || "all"} value={value}>
              {value ? STATUS_LABEL[value] : "All statuses"}
            </option>
          ))}
        </SelectField>
      </div>

      {load.state === "loading" && <TableSkeleton label="Loading discounts" />}
      {load.state === "error" && <ErrorState title={load.message} onRetry={reload} />}
      {load.state === "ready" && load.data.length === 0 && (
        <EmptyState title={q || status ? "No discounts match" : "No discounts yet"}>
          {q || status ? (
            "Try another search or status."
          ) : (
            <Link href="/discounts/new" className="text-primary underline underline-offset-4">
              Create the first discount
            </Link>
          )}
        </EmptyState>
      )}
      {load.state === "ready" && load.data.length > 0 && (
        <Table label="Discounts">
          <thead>
            <tr>
              <th scope="col" className={th}>
                Discount
              </th>
              <th scope="col" className={th}>
                Value
              </th>
              <th scope="col" className={th}>
                Status
              </th>
              <th scope="col" className={`${th} text-right`}>
                Used
              </th>
              <th scope="col" className={th}>
                Dates
              </th>
              <th scope="col" className={th}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {load.data.map((discount) => (
              <tr key={discount.id} className="hover:bg-accent/50">
                <td className={td}>
                  <Link
                    href={`/discounts/${discount.id}`}
                    className="inline-flex min-h-11 flex-col justify-center underline-offset-4 hover:underline"
                  >
                    <span className="font-medium">{discount.code ?? "Automatic"}</span>
                    <span className="text-text-secondary text-xs">{discount.title}</span>
                  </Link>
                </td>
                <td className={td}>{valueLabel(discount)}</td>
                <td className={td}>
                  <DiscountStatusBadge status={discount.status} />
                </td>
                <td className={`${td} text-right tabular-nums`}>
                  {String(discount.times_redeemed)}
                  {discount.max_redemptions !== null && (
                    <span className="text-text-secondary">
                      {" "}
                      / {String(discount.max_redemptions)}
                    </span>
                  )}
                </td>
                <td className={`${td} text-text-secondary whitespace-nowrap`}>
                  {formatDate(discount.starts_at)} –{" "}
                  {discount.ends_at ? formatDate(discount.ends_at) : "no end"}
                </td>
                <td className={`${td} text-right`}>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`${discount.times_redeemed > 0 ? "Deactivate" : "Delete"} ${discount.code ?? discount.title}`}
                    onClick={() => {
                      setRetiring(discount);
                    }}
                  >
                    <Trash2Icon aria-hidden />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <ConfirmDialog
        open={retiring !== null}
        onOpenChange={(open) => {
          if (!open) setRetiring(null);
        }}
        title={`Remove ${retiring?.code ?? retiring?.title ?? "this discount"}?`}
        description={
          retiring && retiring.times_redeemed > 0
            ? `It has been used ${String(retiring.times_redeemed)} times, so it will be kept for order history and deactivated instead of deleted.`
            : "It has never been used, so it will be deleted completely."
        }
        confirmLabel={retiring && retiring.times_redeemed > 0 ? "Deactivate" : "Delete"}
        tone="danger"
        onConfirm={async () => {
          if (!retiring) return null;
          const target = retiring;
          const outcome = await callApi((client) =>
            client.DELETE("/api/v1/admin/discounts/{discount_id}", {
              params: { path: { discount_id: target.id } },
            }),
          );
          if (!outcome.ok) return problemMessage(outcome.problem);
          const name = target.code ?? target.title;
          if (outcome.data.outcome === "deleted") {
            mutate((rows) => rows.filter((row) => row.id !== target.id));
            notify.success(`${name} deleted`);
          } else {
            mutate((rows) =>
              rows.map((row) =>
                row.id === target.id ? { ...row, is_active: false, status: "inactive" } : row,
              ),
            );
            notify.success(`${name} had been used, so it was deactivated rather than deleted`);
          }
          return null;
        }}
      />
    </div>
  );
}
