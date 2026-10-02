"use client";

import { usePathname, useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import type { Interval } from "./format";
import { COHORT_MONTHS, INTERVALS, PRESETS, rangeSearch, type Preset } from "./range";

/*
 * The analytics filters: one row above every chart, all state in the URL.
 * Presets are a segmented group; a custom from/to sits beside them; the
 * interval applies to the time charts. Navigation re-renders the Server
 * Components, whose Suspense boundaries are keyed on the range, so each
 * block shows its skeleton while the new figures load.
 */

interface Current {
  preset: Preset | "custom";
  from: string;
  to: string;
  interval: Interval;
  months: number;
}

const PRESET_LABELS: Record<Preset, string> = {
  7: "7 days",
  30: "30 days",
  90: "90 days",
  365: "12 months",
};
const INTERVAL_LABELS: Record<Interval, string> = { day: "Day", week: "Week", month: "Month" };

function Segment<T extends string | number>({
  label,
  options,
  value,
  render,
  onChange,
  disabled,
}: {
  label: string;
  options: readonly T[];
  value: T | null;
  render: (option: T) => string;
  onChange: (option: T) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="border-border-default inline-flex rounded-md border p-0.5"
    >
      {options.map((option) => (
        <button
          key={String(option)}
          type="button"
          aria-pressed={option === value}
          disabled={disabled}
          onClick={() => {
            onChange(option);
          }}
          className={cn(
            "rounded-[5px] px-3 py-1.5 text-sm transition-colors disabled:opacity-60",
            option === value
              ? "bg-surface-sunken text-text-primary font-semibold"
              : "text-text-secondary hover:text-text-primary",
          )}
        >
          {render(option)}
        </button>
      ))}
    </div>
  );
}

export function RangeControls({ current, today }: { current: Current; today: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const [from, setFrom] = useState(current.from);
  const [to, setTo] = useState(current.to);
  const [error, setError] = useState<string | null>(null);
  const fromId = useId();
  const toId = useId();

  function go(next: Partial<Current>) {
    const merged = { ...current, ...next };
    startTransition(() => {
      router.push(`${pathname}?${rangeSearch(merged)}`, { scroll: false });
    });
  }

  function applyCustom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!from || !to) {
      setError("Choose both dates.");
      return;
    }
    if (from > to) {
      setError("The start date must be on or before the end date.");
      return;
    }
    setError(null);
    go({ preset: "custom", from, to });
  }

  return (
    <div className="flex flex-col gap-3" aria-busy={pending}>
      <div className="flex flex-wrap items-end gap-3">
        <Segment
          label="Date range"
          options={PRESETS}
          value={current.preset === "custom" ? null : current.preset}
          render={(preset) => PRESET_LABELS[preset]}
          onChange={(preset) => {
            go({ preset });
          }}
          disabled={pending}
        />
        <form
          onSubmit={applyCustom}
          className="flex flex-wrap items-end gap-2"
          aria-label="Custom date range"
        >
          <div className="flex flex-col gap-1 text-xs">
            <label htmlFor={fromId} className="text-text-secondary">
              From
            </label>
            <Input
              id={fromId}
              type="date"
              value={from}
              max={today}
              onChange={(event) => {
                setFrom(event.target.value);
              }}
              className="h-9 w-auto text-sm"
              aria-invalid={error !== null}
            />
          </div>
          <div className="flex flex-col gap-1 text-xs">
            <label htmlFor={toId} className="text-text-secondary">
              To
            </label>
            <Input
              id={toId}
              type="date"
              value={to}
              max={today}
              onChange={(event) => {
                setTo(event.target.value);
              }}
              className="h-9 w-auto text-sm"
              aria-invalid={error !== null}
            />
          </div>
          <Button
            type="submit"
            variant={current.preset === "custom" ? "secondary" : "outline"}
            size="sm"
            loading={pending}
          >
            Apply
          </Button>
        </form>
        <Segment
          label="Interval"
          options={INTERVALS}
          value={current.interval}
          render={(interval) => INTERVAL_LABELS[interval]}
          onChange={(interval) => {
            go({ interval });
          }}
          disabled={pending}
        />
      </div>
      {error && (
        <p role="alert" className="text-danger text-sm">
          {error}
        </p>
      )}
    </div>
  );
}

export function CohortMonthsControl({ current }: { current: Current }) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  return (
    <Segment
      label="Cohort months"
      options={COHORT_MONTHS}
      value={current.months}
      render={(months) => `${String(months)} months`}
      onChange={(months) => {
        startTransition(() => {
          router.push(`${pathname}?${rangeSearch({ ...current, months })}`, { scroll: false });
        });
      }}
      disabled={pending}
    />
  );
}
