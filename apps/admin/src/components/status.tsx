import { cn } from "@/lib/utils";

/*
 * Order status badges: one vocabulary with the admin (PAGE-SPECS.md §2.3).
 * The label carries the meaning; the colour only reinforces it.
 */
const LABELS: Record<
  string,
  { label: string; tone: "neutral" | "info" | "success" | "warning" | "danger" }
> = {
  pending: { label: "Pending", tone: "neutral" },
  paid: { label: "Confirmed", tone: "info" },
  processing: { label: "Preparing", tone: "info" },
  partially_fulfilled: { label: "Partly shipped", tone: "info" },
  fulfilled: { label: "Shipped", tone: "info" },
  delivered: { label: "Delivered", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  refunded: { label: "Refunded", tone: "warning" },
  partially_refunded: { label: "Partly refunded", tone: "warning" },
  // Returns
  requested: { label: "Requested", tone: "neutral" },
  approved: { label: "Approved", tone: "info" },
  rejected: { label: "Rejected", tone: "danger" },
  in_transit: { label: "In transit", tone: "info" },
  received: { label: "Received", tone: "info" },
  closed: { label: "Closed", tone: "neutral" },
  // Parcels
  failed: { label: "Delivery failed", tone: "danger" },
};

export function statusLabel(status: string): string {
  return LABELS[status]?.label ?? status.replace(/_/g, " ");
}

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const tone = LABELS[status]?.tone ?? "neutral";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm px-2 py-0.5 text-xs font-medium",
        tone === "neutral" && "bg-surface-sunken text-text-secondary",
        tone === "info" && "bg-info/10 text-info",
        tone === "success" && "bg-success/10 text-success",
        tone === "warning" && "bg-warning/10 text-warning",
        tone === "danger" && "bg-danger/10 text-danger",
        className,
      )}
    >
      {statusLabel(status)}
    </span>
  );
}
