"use client";

import type { ProblemDetail } from "@velo/api-client";
import { useState, type FormEvent, type ReactNode } from "react";

import { FormAlert } from "@/components/forms/fields";
import { problemMessage } from "@/components/people/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fieldErrors } from "@/lib/api-browser";

/** What a dialog's submit handler reports back. */
export type SubmitResult =
  | { ok: true }
  | { ok: false; problem: ProblemDetail }
  | { ok: false; errors: Record<string, string> };

/**
 * A form in a dialog: focus is trapped and returned by Radix, field errors
 * from the API are handed to the form, and anything else shows at the top.
 */
export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  submitLabel,
  onSubmit,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  submitLabel: string;
  onSubmit: () => Promise<SubmitResult>;
  children: (errors: Record<string, string>) => ReactNode;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setProblem(null);
    const result = await onSubmit();
    setSaving(false);
    if (result.ok) {
      setErrors({});
      onOpenChange(false);
      return;
    }
    if ("errors" in result) {
      setErrors(result.errors);
      return;
    }
    const fields = fieldErrors(result.problem);
    setErrors(fields);
    if (Object.keys(fields).length === 0) setProblem(problemMessage(result.problem));
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setErrors({});
          setProblem(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          {problem && <FormAlert title={problem} />}
          {children(errors)}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" loading={saving}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
