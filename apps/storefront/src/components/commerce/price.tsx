import { formatMoney, type Money } from "@velo/api-client";
import { StarIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/*
 * DESIGN-SYSTEM.md §4 "PriceDisplay": tabular figures; a compare-at price
 * struck through with <s>, and the saving as text — a sale is never shown by
 * colour alone (WCAG 1.4.1).
 */
export function PriceDisplay({
  price,
  compareAt,
  priceMax,
  size = "md",
  className,
}: {
  price: Money;
  compareAt?: Money | null | undefined;
  priceMax?: Money | null | undefined;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const onSale = compareAt && compareAt.amount > price.amount;
  const percent = onSale ? Math.round((1 - price.amount / compareAt.amount) * 100) : 0;
  const range = priceMax && priceMax.amount > price.amount;
  return (
    <p
      className={cn(
        "flex flex-wrap items-baseline gap-x-2 tabular-nums",
        size === "lg" && "text-2xl font-semibold",
        size === "md" && "text-base font-medium",
        size === "sm" && "text-sm font-medium",
        className,
      )}
    >
      <span>
        {range ? "From " : ""}
        {formatMoney(price)}
      </span>
      {onSale && (
        <>
          <s className="text-text-tertiary font-normal">
            <span className="sr-only">Was </span>
            {formatMoney(compareAt)}
          </s>
          <span className="bg-sale/10 text-sale rounded-sm px-1.5 py-0.5 text-xs font-semibold">
            −{percent}%
          </span>
        </>
      )}
    </p>
  );
}

export function RatingStars({
  average,
  count,
  className,
}: {
  average: number;
  count?: number | undefined;
  className?: string;
}) {
  const rounded = Math.round(average * 2) / 2;
  return (
    <span className={cn("inline-flex items-center gap-1 text-sm", className)}>
      <span className="sr-only">
        Rated {average.toFixed(1)} out of 5
        {count !== undefined ? ` from ${String(count)} reviews` : ""}
      </span>
      <span aria-hidden className="flex">
        {[1, 2, 3, 4, 5].map((star) => (
          <StarIcon
            key={star}
            className={cn(
              "size-4",
              star <= rounded ? "fill-warning text-warning" : "text-border-default",
            )}
          />
        ))}
      </span>
      {count !== undefined && (
        <span aria-hidden className="text-text-secondary">
          ({count})
        </span>
      )}
    </span>
  );
}
