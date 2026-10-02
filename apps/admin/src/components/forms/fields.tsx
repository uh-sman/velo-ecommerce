"use client";

import { CircleAlertIcon, CircleCheckIcon, CircleIcon, EyeIcon, EyeOffIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react";

import { Input } from "@/components/ui/input";
import { passwordRequirements, passwordStrength, type Strength } from "@/lib/password";
import { cn } from "@/lib/utils";

/*
 * Form fields to DESIGN-SYSTEM.md §4 and §6 "Forms": the label is always
 * visible above the input (placeholder-as-label strands anyone interrupted
 * mid-form), errors sit below with an icon — never colour alone — and are
 * linked with aria-describedby, with aria-invalid set.
 */

interface FieldProps extends Omit<ComponentProps<"input">, "id"> {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  optional?: boolean;
}

function describedBy(...ids: (string | false | undefined)[]): string | undefined {
  const joined = ids.filter(Boolean).join(" ");
  return joined || undefined;
}

export function TextField({ label, hint, error, optional, className, ...props }: FieldProps) {
  const id = useId();
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
        {optional && <span className="text-text-tertiary font-normal"> (optional)</span>}
      </label>
      <Input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hint !== undefined && `${id}-hint`, error && `${id}-error`)}
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

export function FieldError({ id, message }: { id: string; message?: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} className="text-danger flex items-start gap-1.5 text-sm">
      <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
      {message}
    </p>
  );
}

interface PasswordFieldProps extends FieldProps {
  /** Rendered between the label row and the input — the requirements list. */
  before?: ReactNode;
}

export function PasswordField({
  label,
  hint,
  error,
  before,
  className,
  ...props
}: PasswordFieldProps) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {before}
      <div className="relative">
        <Input
          id={id}
          type={visible ? "text" : "password"}
          className="pr-12"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(hint !== undefined && `${id}-hint`, error && `${id}-error`)}
          {...props}
        />
        <button
          type="button"
          onClick={() => {
            setVisible((current) => !current);
          }}
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          className="text-text-secondary hover:text-text-primary focus-visible:ring-ring/50 absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-md outline-none focus-visible:ring-[3px]"
        >
          {visible ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
        </button>
      </div>
      {hint !== undefined && (
        <div id={`${id}-hint`} className="text-text-secondary text-sm">
          {hint}
        </div>
      )}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

const STRENGTH_LABEL: Record<Strength, string> = {
  empty: "",
  weak: "Weak",
  fair: "Fair",
  strong: "Strong",
};

const STRENGTH_BARS: Record<Strength, number> = { empty: 0, weak: 1, fair: 2, strong: 3 };

/**
 * Requirements shown *before* typing, ticked live as they are met, plus an
 * advisory strength meter that never blocks submission (PAGE-SPECS.md §2.2).
 */
export function PasswordRequirements({ password, email }: { password: string; email: string }) {
  const requirements = passwordRequirements(password, email);
  const strength = passwordStrength(password);
  return (
    <div className="flex flex-col gap-2">
      <ul className="text-text-secondary flex flex-col gap-1 text-sm" aria-live="polite">
        {requirements.map((requirement) => (
          <li
            key={requirement.id}
            className={cn("flex items-center gap-1.5", requirement.met && "text-success")}
          >
            {requirement.met ? (
              <CircleCheckIcon className="size-4" aria-hidden />
            ) : (
              <CircleIcon className="size-4" aria-hidden />
            )}
            {requirement.label}
            <span className="sr-only">{requirement.met ? "(met)" : "(not yet met)"}</span>
          </li>
        ))}
      </ul>
      {strength !== "empty" && (
        <div className="flex items-center gap-2">
          <div className="flex flex-1 gap-1" aria-hidden>
            {[1, 2, 3].map((bar) => (
              <span
                key={bar}
                className={cn(
                  "h-1 flex-1 rounded-full",
                  bar <= STRENGTH_BARS[strength]
                    ? strength === "weak"
                      ? "bg-danger"
                      : strength === "fair"
                        ? "bg-warning"
                        : "bg-success"
                    : "bg-border-subtle",
                )}
              />
            ))}
          </div>
          <span className="text-text-secondary text-xs">Strength: {STRENGTH_LABEL[strength]}</span>
        </div>
      )}
    </div>
  );
}

/**
 * A form-level message. When it appears, focus moves to it, so a screen-reader
 * user hears what went wrong instead of silence (PAGE-SPECS.md §2.1).
 */
export function FormAlert({
  tone = "danger",
  title,
  children,
}: {
  tone?: "danger" | "success" | "info";
  title: string;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [title]);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "rounded-md border p-3 text-sm outline-none",
        tone === "danger" && "border-danger/40 bg-danger/10",
        tone === "success" && "border-success/40 bg-success/10",
        tone === "info" && "border-info/40 bg-info/10",
      )}
    >
      <p className="font-medium">{title}</p>
      {children && <div className="text-text-secondary mt-1">{children}</div>}
    </div>
  );
}
