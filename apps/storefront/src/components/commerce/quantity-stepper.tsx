"use client";

import { MinusIcon, PlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/*
 * DESIGN-SYSTEM.md §4 "QuantityStepper": − and + plus a numeric input; −
 * disabled at 1, + at the stock cap; changes debounced 300 ms before they
 * reach the server. The parent rolls back by passing the server's value.
 */
export function QuantityStepper({
  value,
  max,
  onChange,
  disabled = false,
  label,
}: {
  value: number;
  max: number;
  onChange: (quantity: number) => void;
  disabled?: boolean;
  label: string;
}) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function commit(next: number) {
    const clamped = Math.max(1, Math.min(max, Math.round(next) || 1));
    setDraft(clamped);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (clamped !== value) onChange(clamped);
    }, 300);
  }

  const button =
    "hover:bg-accent flex size-11 items-center justify-center disabled:pointer-events-none disabled:opacity-40 focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px]";

  return (
    <div
      className={cn(
        "border-border-default inline-flex items-center rounded-md border",
        disabled && "opacity-60",
      )}
    >
      <button
        type="button"
        className={cn(button, "rounded-l-md")}
        onClick={() => {
          commit(draft - 1);
        }}
        disabled={disabled || draft <= 1}
        aria-label={`Decrease quantity of ${label}`}
      >
        <MinusIcon className="size-4" aria-hidden />
      </button>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        className="h-11 w-12 bg-transparent text-center tabular-nums outline-none"
        value={draft}
        disabled={disabled}
        aria-label={`Quantity of ${label}`}
        onChange={(event) => {
          const parsed = Number.parseInt(event.target.value.replace(/\D/g, ""), 10);
          if (!Number.isNaN(parsed)) commit(parsed);
        }}
      />
      <button
        type="button"
        className={cn(button, "rounded-r-md")}
        onClick={() => {
          commit(draft + 1);
        }}
        disabled={disabled || draft >= max}
        aria-label={`Increase quantity of ${label}`}
      >
        <PlusIcon className="size-4" aria-hidden />
      </button>
    </div>
  );
}
