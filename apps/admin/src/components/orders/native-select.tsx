import { useId, type ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * A labelled native `<select>`: the platform's own keyboard and screen-reader
 * behaviour, styled like Input. For filter bars and short forms where a
 * custom listbox adds nothing.
 */
export function NativeSelect({
  label,
  options,
  className,
  hideLabel = false,
  ...props
}: Omit<ComponentProps<"select">, "id" | "children"> & {
  label: string;
  options: readonly { value: string; label: string }[];
  hideLabel?: boolean;
}) {
  const id = useId();
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className={cn("text-sm font-medium", hideLabel && "sr-only")}>
        {label}
      </label>
      <select
        id={id}
        className={cn(
          "border-border-default bg-surface-raised text-text-primary h-10 w-full min-w-0 rounded-md border px-2 text-sm",
          "focus-visible:border-border-focus focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px]",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
        {...props}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
