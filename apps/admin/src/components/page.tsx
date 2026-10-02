"use client";

import { formatMoney, type Money } from "@velo/api-client";
import { InboxIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { FormAlert } from "@/components/forms/fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/*
 * The admin's shared page parts. Every list and detail page is built from
 * these, so headers, empty states, errors, money, dates and confirmations
 * look and read the same everywhere.
 */

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-text-secondary mt-1 text-sm">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Section({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "border-border-subtle bg-surface-raised rounded-lg border p-4 lg:p-5",
        className,
      )}
    >
      {(title || actions) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="font-semibold">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center">
      <InboxIcon className="text-text-tertiary size-8" aria-hidden />
      <p className="font-medium">{title}</p>
      {children && <div className="text-text-secondary text-sm">{children}</div>}
    </div>
  );
}

export function ErrorState({ title, onRetry }: { title: string; onRetry?: () => void }) {
  return (
    <FormAlert title={title}>
      {onRetry && (
        <Button type="button" variant="link" className="h-auto p-0" onClick={onRetry}>
          Try again
        </Button>
      )}
    </FormAlert>
  );
}

/** Minor units in, the currency's own format out. Null shows a dash, never $0.00. */
export function MoneyText({
  money,
  className,
}: {
  money: Money | null | undefined;
  className?: string;
}) {
  return <span className={cn("tabular-nums", className)}>{money ? formatMoney(money) : "—"}</span>;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Minor units ⇄ the decimal string an operator types ("12.50"). */
export function toMajor(minor: number | null | undefined): string {
  return minor === null || minor === undefined ? "" : (minor / 100).toFixed(2);
}

export function toMinor(major: string): number | null {
  const parsed = Number.parseFloat(major.replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

/**
 * "Are you sure?" for anything that moves money, removes access, or cannot be
 * undone. The confirm button names the action and shows its pending state.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  tone = "primary",
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  tone?: "primary" | "danger";
  onConfirm: () => Promise<string | null>; // a message on failure
  children?: ReactNode;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
        {error && <FormAlert title={error} />}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            loading={pending}
            onClick={() => {
              setPending(true);
              setError(null);
              void onConfirm().then((failure) => {
                setPending(false);
                if (failure) setError(failure);
                else onOpenChange(false);
              });
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A plain, accessible table wrapper that scrolls sideways on small screens. */
export function Table({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="border-border-subtle overflow-x-auto rounded-lg border">
      <table aria-label={label} className="w-full min-w-[40rem] text-left text-sm">
        {children}
      </table>
    </div>
  );
}

export const th =
  "bg-surface-sunken text-text-secondary px-3 py-2 text-xs font-medium uppercase tracking-wide";
export const td = "border-border-subtle border-t px-3 py-2.5 align-middle";
