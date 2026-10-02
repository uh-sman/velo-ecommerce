import { cva, type VariantProps } from "class-variance-authority";
import { Loader2Icon } from "lucide-react";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/*
 * Vendored from shadcn/ui and rebuilt to DESIGN-SYSTEM.md §4 "Button":
 * variants primary · secondary · outline · ghost · danger · link,
 * sizes sm 32 · md 40 · lg 48 · xl 56, and a loading state that cannot
 * shift the layout.
 */
const buttonVariants = cva(
  [
    "relative inline-flex shrink-0 items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap",
    "transition-colors duration-150 outline-none",
    "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-offset-1",
    "disabled:pointer-events-none disabled:opacity-50",
    "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground hover:bg-brand-hover",
        secondary: "bg-secondary text-secondary-foreground hover:bg-border-subtle",
        outline: "border border-border-default bg-transparent hover:bg-accent",
        ghost: "hover:bg-accent",
        danger: "bg-destructive text-white hover:bg-destructive/90",
        link: "text-primary underline underline-offset-4 hover:no-underline",
      },
      size: {
        // sm and md are visually under 44px; the ::after extends the hit
        // area to 44px without changing the layout (WCAG 2.5.5).
        sm: "h-8 px-3 text-sm after:absolute after:inset-x-0 after:-inset-y-1.5",
        md: "h-10 px-4 text-sm after:absolute after:inset-x-0 after:-inset-y-0.5",
        lg: "h-12 px-6 text-base",
        xl: "h-14 px-8 text-lg",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

type ButtonProps = ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    /**
     * Replaces the label with a spinner and disables the button. The label
     * stays in the layout, invisible, so the width is locked to the
     * pre-loading width — a checkout button that resizes mid-submit looks
     * broken at the moment trust matters most.
     */
    loading?: boolean;
  };

function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant ?? "primary"}
      data-size={size ?? "md"}
      className={cn(buttonVariants({ variant, size, className }))}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {/* Slot needs a single child, so `asChild` (links) has no loading state. */}
      {loading && !asChild ? (
        <>
          <span className="invisible contents">{children}</span>
          <span className="absolute inset-0 flex items-center justify-center">
            <Loader2Icon className="animate-spin" aria-hidden />
            <span className="sr-only">Loading</span>
          </span>
        </>
      ) : (
        children
      )}
    </Comp>
  );
}

export { Button, buttonVariants };
export type { ButtonProps };
