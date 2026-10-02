import { cn } from "@/lib/utils";

/*
 * Payment and fulfilment are separate columns and separate badges
 * (PAGE-SPECS.md §3.4): their vocabularies overlap ("failed", "refunded") but
 * do not mean the same thing, so they do not share StatusBadge's labels.
 */

type Tone = "neutral" | "info" | "success" | "warning" | "danger";

const PAYMENT: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "Unpaid", tone: "warning" },
  paid: { label: "Paid", tone: "success" },
  partially_refunded: { label: "Partly refunded", tone: "warning" },
  refunded: { label: "Refunded", tone: "neutral" },
  failed: { label: "Payment failed", tone: "danger" },
};

const FULFILMENT: Record<string, { label: string; tone: Tone }> = {
  unfulfilled: { label: "Unfulfilled", tone: "warning" },
  partially_fulfilled: { label: "Partly shipped", tone: "info" },
  fulfilled: { label: "Shipped", tone: "success" },
  returned: { label: "Returned", tone: "neutral" },
};

const REFUND: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "Pending", tone: "warning" },
  succeeded: { label: "Refunded", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

function Badge({
  label,
  tone,
  className,
}: {
  label: string;
  tone: Tone;
  className?: string | undefined;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-sm px-2 py-0.5 text-xs font-medium",
        tone === "neutral" && "bg-surface-sunken text-text-secondary",
        tone === "info" && "bg-info/10 text-info",
        tone === "success" && "bg-success/10 text-success",
        tone === "warning" && "bg-warning/10 text-warning",
        tone === "danger" && "bg-danger/10 text-danger",
        className,
      )}
    >
      {label}
    </span>
  );
}

function fallback(status: string) {
  return { label: status.replace(/_/g, " "), tone: "neutral" as const };
}

export function PaymentBadge({ status, className }: { status: string; className?: string }) {
  const { label, tone } = PAYMENT[status] ?? fallback(status);
  return <Badge label={label} tone={tone} className={className} />;
}

export function FulfilmentBadge({ status, className }: { status: string; className?: string }) {
  const { label, tone } = FULFILMENT[status] ?? fallback(status);
  return <Badge label={label} tone={tone} className={className} />;
}

export function RefundBadge({ status, className }: { status: string; className?: string }) {
  const { label, tone } = REFUND[status] ?? fallback(status);
  return <Badge label={label} tone={tone} className={className} />;
}
