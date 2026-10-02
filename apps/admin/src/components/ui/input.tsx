import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/*
 * DESIGN-SYSTEM.md §4 "Form fields": 40px, `--radius-md`, and 16px text so iOS
 * Safari does not zoom the page on focus mid-checkout.
 */
function Input({ className, type = "text", ...props }: ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "border-border-default bg-surface-raised text-text-primary h-10 w-full min-w-0 rounded-md border px-3 text-base",
        "placeholder:text-text-tertiary outline-none transition-colors",
        "focus-visible:border-border-focus focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        "aria-invalid:border-danger disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
