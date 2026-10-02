"use client";

import type { ProblemDetail } from "@velo/api-client";
import { LockIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";

import { FieldError } from "@/components/forms/fields";
import { PageHeader } from "@/components/page";
import { useCan } from "@/components/shell/me-context";
import { Skeleton } from "@/components/ui/skeleton";
import type { Outcome } from "@/lib/api-browser";
import type { Permission } from "@/lib/permissions";
import { cn } from "@/lib/utils";

/*
 * Small pieces shared by the People and Settings sections: loading a resource
 * with its three states, cursor lists, permission gates, and the form controls
 * the shared `fields.tsx` does not have (select, textarea, checkbox, radios).
 */

/** The sentence to show for an API problem: the detail when there is one. */
export function problemMessage(problem: ProblemDetail): string {
  return problem.detail ?? problem.title;
}

export type Load<T> =
  { state: "loading" } | { state: "error"; message: string } | { state: "ready"; data: T };

/**
 * Load one resource. `key` changes trigger a reload; `reload()` retries;
 * `mutate()` edits the loaded data in place after a successful write.
 */
export function useResource<T>(fetcher: () => Promise<Outcome<T>>, key: string) {
  const [load, setLoad] = useState<Load<T>>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(fetcher);
  latest.current = fetcher;

  useEffect(() => {
    let live = true;
    setLoad({ state: "loading" });
    void latest.current().then((outcome) => {
      if (!live) return;
      setLoad(
        outcome.ok
          ? { state: "ready", data: outcome.data }
          : { state: "error", message: problemMessage(outcome.problem) },
      );
    });
    return () => {
      live = false;
    };
  }, [key, attempt]);

  const reload = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);
  const mutate = useCallback((change: (data: T) => T) => {
    setLoad((current) =>
      current.state === "ready" ? { state: "ready", data: change(current.data) } : current,
    );
  }, []);
  return { load, reload, mutate };
}

interface Page<T> {
  data: T[];
  pagination: { next_cursor: string | null; has_more: boolean; total_count?: number | null };
}

/** A cursor-paginated list: the first page on `key` change, then "Load more". */
export function useCursorList<T>(
  fetchPage: (cursor: string | null) => Promise<Outcome<Page<T>>>,
  key: string,
) {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(fetchPage);
  latest.current = fetchPage;

  useEffect(() => {
    let live = true;
    setState("loading");
    setMoreError(null);
    void latest.current(null).then((outcome) => {
      if (!live) return;
      if (!outcome.ok) {
        setError(problemMessage(outcome.problem));
        setState("error");
        return;
      }
      setItems(outcome.data.data);
      setCursor(outcome.data.pagination.has_more ? outcome.data.pagination.next_cursor : null);
      setTotal(outcome.data.pagination.total_count ?? null);
      setState("ready");
    });
    return () => {
      live = false;
    };
  }, [key, attempt]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    setMoreError(null);
    const outcome = await latest.current(cursor);
    setLoadingMore(false);
    if (!outcome.ok) {
      setMoreError(problemMessage(outcome.problem));
      return;
    }
    setItems((current) => [...current, ...outcome.data.data]);
    setCursor(outcome.data.pagination.has_more ? outcome.data.pagination.next_cursor : null);
  }

  return {
    items,
    setItems,
    total,
    state,
    error,
    hasMore: cursor !== null,
    loadingMore,
    moreError,
    loadMore: () => {
      void loadMore();
    },
    retry: () => {
      setAttempt((current) => current + 1);
    },
  };
}

/** A value that settles `delay` ms after the last change — for search boxes. */
export function useDebounced<T>(value: T, delay = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value);
    }, delay);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delay]);
  return settled;
}

/** The whole page, or a plain explanation for a role that cannot use it. */
export function RequirePermission({
  permission,
  title,
  children,
}: {
  permission: Permission;
  title: string;
  children: ReactNode;
}) {
  if (useCan(permission)) return <>{children}</>;
  return (
    <>
      <PageHeader title={title} />
      <div className="flex flex-col items-center gap-2 py-16 text-center">
        <LockIcon className="text-text-tertiary size-8" aria-hidden />
        <p className="font-medium">Your role does not include this page</p>
        <p className="text-text-secondary text-sm">Ask an owner if you need access.</p>
      </div>
    </>
  );
}

/** Table-shaped skeleton rows, so the page does not jump when data arrives. */
export function TableSkeleton({ rows = 6, label }: { rows?: number; label: string }) {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label={label}>
      <Skeleton className="h-9 w-full" />
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-12 w-full" />
      ))}
    </div>
  );
}

const control =
  "border-border-default bg-surface-raised text-text-primary h-10 w-full min-w-0 rounded-md border px-3 text-base outline-none transition-colors focus-visible:border-border-focus focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:border-danger disabled:cursor-not-allowed disabled:opacity-50";

interface SelectFieldProps extends Omit<ComponentProps<"select">, "id"> {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  hideLabel?: boolean;
}

/** A native select: the OS picker on phones, and the control people already know. */
export function SelectField({
  label,
  hint,
  error,
  hideLabel,
  className,
  children,
  ...props
}: SelectFieldProps) {
  const id = useId();
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className={cn("text-sm font-medium", hideLabel && "sr-only")}>
        {label}
      </label>
      <select
        id={id}
        className={control}
        aria-invalid={error ? true : undefined}
        aria-describedby={
          [hint !== undefined && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") ||
          undefined
        }
        {...props}
      >
        {children}
      </select>
      {hint !== undefined && (
        <div id={`${id}-hint`} className="text-text-secondary text-sm">
          {hint}
        </div>
      )}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

interface TextAreaFieldProps extends Omit<ComponentProps<"textarea">, "id"> {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
}

export function TextAreaField({ label, hint, error, className, ...props }: TextAreaFieldProps) {
  const id = useId();
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <textarea
        id={id}
        className={cn(control, "h-auto min-h-24 py-2")}
        aria-invalid={error ? true : undefined}
        aria-describedby={
          [hint !== undefined && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") ||
          undefined
        }
        {...props}
      />
      {hint !== undefined && (
        <div id={`${id}-hint`} className="text-text-secondary text-sm">
          {hint}
        </div>
      )}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

/** A checkbox whose label is part of the 44px target. */
export function CheckField({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex flex-col">
      <label
        htmlFor={id}
        className={cn(
          "flex min-h-11 cursor-pointer items-center gap-3 text-sm",
          disabled && "cursor-not-allowed opacity-60",
        )}
      >
        <input
          id={id}
          type="checkbox"
          className="accent-primary size-5 shrink-0"
          checked={checked}
          disabled={disabled}
          aria-describedby={hint !== undefined ? `${id}-hint` : undefined}
          onChange={(event) => {
            onChange(event.target.checked);
          }}
        />
        <span>{label}</span>
      </label>
      {hint !== undefined && (
        <p id={`${id}-hint`} className="text-text-secondary -mt-1 pl-8 text-sm">
          {hint}
        </p>
      )}
    </div>
  );
}

/** Radios, always in a fieldset with a legend. */
export function RadioGroup<V extends string>({
  legend,
  name,
  value,
  options,
  onChange,
  error,
  disabled,
  inline,
}: {
  legend: string;
  name: string;
  value: V;
  options: readonly { value: V; label: ReactNode; hint?: ReactNode }[];
  onChange: (value: V) => void;
  error?: string | undefined;
  disabled?: boolean;
  inline?: boolean;
}) {
  const id = useId();
  return (
    <fieldset
      className="flex flex-col gap-1"
      aria-describedby={error ? `${id}-error` : undefined}
      disabled={disabled}
    >
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      <div className={cn("flex flex-col", inline && "flex-row flex-wrap gap-x-6")}>
        {options.map((option) => (
          <label
            key={option.value}
            className="flex min-h-11 cursor-pointer items-start gap-3 py-2.5 text-sm"
          >
            <input
              type="radio"
              name={`${name}-${id}`}
              value={option.value}
              className="accent-primary mt-0.5 size-5 shrink-0"
              checked={value === option.value}
              onChange={() => {
                onChange(option.value);
              }}
            />
            <span>
              {option.label}
              {option.hint !== undefined && (
                <span className="text-text-secondary block">{option.hint}</span>
              )}
            </span>
          </label>
        ))}
      </div>
      <FieldError id={`${id}-error`} message={error} />
    </fieldset>
  );
}

/** "Load more", its pending state, and a retry when the next page fails. */
export function LoadMore({
  hasMore,
  loading,
  error,
  onLoadMore,
  shown,
  total,
  noun,
}: {
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  onLoadMore: () => void;
  shown: number;
  total: number | null;
  noun: string;
}) {
  return (
    <div className="mt-4 flex flex-col items-center gap-2 text-sm">
      <p className="text-text-secondary" aria-live="polite">
        Showing {String(shown)}
        {total !== null ? ` of ${String(total)}` : ""} {noun}
      </p>
      {error && <p className="text-danger">{error}</p>}
      {hasMore && (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loading}
          className="border-border-default hover:bg-accent focus-visible:ring-ring/50 min-h-11 rounded-md border px-4 font-medium outline-none focus-visible:ring-[3px] disabled:opacity-50"
        >
          {loading ? "Loading…" : error ? "Try again" : "Load more"}
        </button>
      )}
    </div>
  );
}

export function fullName(person: { first_name: string | null; last_name: string | null }): string {
  return [person.first_name, person.last_name].filter(Boolean).join(" ");
}
