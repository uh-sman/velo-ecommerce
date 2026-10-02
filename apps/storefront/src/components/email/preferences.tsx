"use client";

import type { Schema } from "@velo/api-client";
import { useCallback, useEffect, useState } from "react";

import { FormAlert } from "@/components/forms/fields";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ui/sonner";
import { callApi } from "@/lib/api-browser";

type Preferences = Schema<"PreferencesView">;

/*
 * Which emails a customer gets. Order emails cannot be turned off — they are
 * how a receipt, a tracking link or a refund reaches you — so they are shown,
 * checked and disabled, with the reason. Each toggle saves on change, and is
 * put back if the save fails.
 */
export function EmailPreferences() {
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    const outcome = await callApi((client) => client.GET("/api/v1/account/preferences"));
    if (outcome.ok) setPrefs(outcome.data);
    else setFailed(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function change(key: "cart_reminders" | "marketing", value: boolean) {
    if (!prefs) return;
    const before = prefs;
    setPrefs({ ...prefs, [key]: value });
    const outcome = await callApi((client) =>
      client.PATCH("/api/v1/account/preferences", { body: { [key]: value } }),
    );
    if (outcome.ok) {
      setPrefs(outcome.data);
      notify.success("Saved");
    } else {
      setPrefs(before);
      notify.error("We could not save that. Please try again.");
    }
  }

  if (failed) {
    return (
      <FormAlert title="We could not load your preferences">
        <Button variant="link" className="h-auto p-0" onClick={() => void load()}>
          Try again
        </Button>
      </FormAlert>
    );
  }
  if (!prefs) return <Skeleton className="h-40" />;

  return (
    <fieldset className="flex flex-col gap-4">
      <legend className="sr-only">Emails we send you</legend>
      <Row
        id="pref-orders"
        label="Order updates"
        hint="Receipts, shipping and delivery, returns and refunds. Always on: this is how they reach you."
        checked
        disabled
      />
      <Row
        id="pref-cart"
        label="Cart reminders"
        hint="Up to three reminders when you leave something in your cart."
        checked={prefs.cart_reminders}
        onChange={(value) => void change("cart_reminders", value)}
      />
      <Row
        id="pref-marketing"
        label="News and offers"
        hint="New arrivals and promotions, now and then."
        checked={prefs.marketing}
        onChange={(value) => void change("marketing", value)}
      />
    </fieldset>
  );
}

function Row({
  id,
  label,
  hint,
  checked,
  disabled = false,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange?: (value: boolean) => void;
}) {
  return (
    <div className="border-border-subtle flex items-start gap-3 rounded-lg border p-4">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        aria-describedby={`${id}-hint`}
        onCheckedChange={(value) => onChange?.(value === true)}
        className="mt-0.5"
      />
      <div>
        <label htmlFor={id} className="font-medium">
          {label}
        </label>
        <p id={`${id}-hint`} className="text-text-secondary text-sm">
          {hint}
        </p>
      </div>
    </div>
  );
}
