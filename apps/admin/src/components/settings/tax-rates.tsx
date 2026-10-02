"use client";

import type { Schema } from "@velo/api-client";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { TextField } from "@/components/forms/fields";
import { EmptyState, ErrorState, Table, td, th } from "@/components/page";
import { CheckField, TableSkeleton, problemMessage, useResource } from "@/components/people/shared";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ui/sonner";
import { callApi } from "@/lib/api-browser";

import { FormDialog, type SubmitResult } from "./form-dialog";

type Tax = Schema<"TaxView">;

/** "0.0725" → "7.25". */
export function fractionToPercent(rate: string): string {
  const value = Number(rate);
  return Number.isFinite(value) ? String(Number((value * 100).toFixed(4))) : rate;
}

/** "7.25" → "0.0725"; null when it is not a percent from 0 to 100 with at most 2 decimals. */
export function percentToFraction(percent: string): string | null {
  const trimmed = percent.trim().replace(/%$/, "");
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (value < 0 || value > 100) return null;
  return (value / 100).toFixed(4);
}

export function TaxRates() {
  const { load, reload, mutate } = useResource(
    () => callApi((client) => client.GET("/api/v1/admin/tax-rates")),
    "tax",
  );
  const [dialog, setDialog] = useState<{ tax: Tax | null } | null>(null);

  function replace(tax: Tax) {
    mutate((rows) => rows.map((row) => (row.id === tax.id ? tax : row)));
  }

  async function toggle(tax: Tax, active: boolean) {
    replace({ ...tax, is_active: active });
    const outcome = await callApi((client) =>
      client.PATCH("/api/v1/admin/tax-rates/{tax_id}", {
        params: { path: { tax_id: tax.id } },
        body: { is_active: active },
      }),
    );
    if (!outcome.ok) {
      replace(tax);
      notify.error(problemMessage(outcome.problem));
      return;
    }
    replace(outcome.data);
    notify.success(`${tax.name} ${active ? "switched on" : "switched off"}`);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-text-secondary max-w-2xl text-sm">
          A rate matches an address in its country — and its region and postal prefix, when set. Of
          the active rates that match, those with the highest priority all apply together, so a
          state rate and a county rate at the same priority add up.
        </p>
        <Button
          onClick={() => {
            setDialog({ tax: null });
          }}
        >
          <PlusIcon aria-hidden />
          Add tax rate
        </Button>
      </div>

      {load.state === "loading" && <TableSkeleton rows={4} label="Loading tax rates" />}
      {load.state === "error" && <ErrorState title={load.message} onRetry={reload} />}
      {load.state === "ready" && load.data.length === 0 && (
        <EmptyState title="No tax rates yet">
          Orders are charged no tax until you add a rate for the places you ship to.
        </EmptyState>
      )}
      {load.state === "ready" && load.data.length > 0 && (
        <Table label="Tax rates">
          <thead>
            <tr>
              <th scope="col" className={th}>
                Name
              </th>
              <th scope="col" className={th}>
                Where
              </th>
              <th scope="col" className={`${th} text-right`}>
                Rate
              </th>
              <th scope="col" className={th}>
                Prices
              </th>
              <th scope="col" className={`${th} text-right`}>
                Priority
              </th>
              <th scope="col" className={th}>
                Active
              </th>
              <th scope="col" className={th}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {load.data.map((tax) => (
              <tr key={tax.id}>
                <td className={`${td} font-medium`}>{tax.name}</td>
                <td className={td}>
                  {[
                    tax.country_code,
                    tax.region,
                    tax.postal_prefix && `postcodes ${tax.postal_prefix}…`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </td>
                <td className={`${td} text-right tabular-nums`}>{fractionToPercent(tax.rate)}%</td>
                <td className={td}>
                  {tax.is_inclusive ? "Included in price" : "Added at checkout"}
                </td>
                <td className={`${td} text-right tabular-nums`}>{String(tax.priority)}</td>
                <td className={td}>
                  <CheckField
                    label={<span className="sr-only">{tax.name} active</span>}
                    checked={tax.is_active}
                    onChange={(checked) => {
                      void toggle(tax, checked);
                    }}
                  />
                </td>
                <td className={`${td} text-right`}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setDialog({ tax });
                    }}
                  >
                    Edit<span className="sr-only"> {tax.name}</span>
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {dialog && (
        <TaxDialog
          tax={dialog.tax}
          onClose={() => {
            setDialog(null);
          }}
          onSaved={(tax, created) => {
            if (created) mutate((rows) => [...rows, tax]);
            else replace(tax);
            notify.success(created ? `${tax.name} added` : `${tax.name} saved`);
          }}
        />
      )}
    </div>
  );
}

function TaxDialog({
  tax,
  onClose,
  onSaved,
}: {
  tax: Tax | null;
  onClose: () => void;
  onSaved: (tax: Tax, created: boolean) => void;
}) {
  const [name, setName] = useState(tax?.name ?? "");
  const [country, setCountry] = useState(tax?.country_code ?? "");
  const [region, setRegion] = useState(tax?.region ?? "");
  const [postal, setPostal] = useState(tax?.postal_prefix ?? "");
  const [percent, setPercent] = useState(tax ? fractionToPercent(tax.rate) : "");
  const [inclusive, setInclusive] = useState(tax?.is_inclusive ?? false);
  const [priority, setPriority] = useState(String(tax?.priority ?? 0));
  const [active, setActive] = useState(tax?.is_active ?? true);

  async function submit(): Promise<SubmitResult> {
    const rate = percentToFraction(percent);
    if (rate === null) {
      return { ok: false, errors: { rate: "Enter a percent from 0 to 100, such as 7.25." } };
    }
    const priorityValue = Number(priority);
    if (!Number.isInteger(priorityValue)) {
      return { ok: false, errors: { priority: "A whole number, such as 0." } };
    }
    const fields = {
      name: name.trim(),
      region: region.trim() || null,
      postal_prefix: postal.trim() || null,
      rate,
      is_inclusive: inclusive,
      priority: priorityValue,
      is_active: active,
    };
    const outcome = tax
      ? await callApi((client) =>
          client.PATCH("/api/v1/admin/tax-rates/{tax_id}", {
            params: { path: { tax_id: tax.id } },
            body: fields,
          }),
        )
      : await callApi((client) =>
          client.POST("/api/v1/admin/tax-rates", {
            body: { ...fields, country_code: country.trim().toUpperCase() },
          }),
        );
    if (!outcome.ok) return { ok: false, problem: outcome.problem };
    onSaved(outcome.data, tax === null);
    return { ok: true };
  }

  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={tax ? `Edit ${tax.name}` : "Add a tax rate"}
      submitLabel={tax ? "Save tax rate" : "Add tax rate"}
      onSubmit={submit}
    >
      {(errors) => (
        <div className="flex flex-col gap-4">
          <TextField
            label="Name"
            placeholder="California sales tax"
            maxLength={120}
            value={name}
            error={errors["name"]}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <div className="grid gap-4 sm:grid-cols-3">
            <TextField
              label="Country"
              placeholder="US"
              maxLength={2}
              autoCapitalize="characters"
              spellCheck={false}
              hint={tax ? "Fixed once created." : "Two-letter code."}
              disabled={tax !== null}
              value={country}
              error={errors["country_code"]}
              onChange={(event) => {
                setCountry(event.target.value.toUpperCase());
              }}
            />
            <TextField
              label="Region"
              optional
              placeholder="CA"
              maxLength={60}
              value={region}
              error={errors["region"]}
              onChange={(event) => {
                setRegion(event.target.value);
              }}
            />
            <TextField
              label="Postal prefix"
              optional
              placeholder="90"
              maxLength={20}
              value={postal}
              error={errors["postal_prefix"]}
              onChange={(event) => {
                setPostal(event.target.value);
              }}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Rate (%)"
              inputMode="decimal"
              placeholder="7.25"
              hint="As a percent: 7.25 means 7.25%."
              value={percent}
              error={errors["rate"]}
              onChange={(event) => {
                setPercent(event.target.value);
              }}
            />
            <TextField
              label="Priority"
              type="number"
              inputMode="numeric"
              hint="Only the matching rates with the highest priority apply."
              value={priority}
              error={errors["priority"]}
              onChange={(event) => {
                setPriority(event.target.value);
              }}
            />
          </div>
          <CheckField
            label="Prices already include this tax"
            hint="On: the tax is part of the shelf price. Off: it is added at checkout."
            checked={inclusive}
            onChange={setInclusive}
          />
          <CheckField label="Active" checked={active} onChange={setActive} />
        </div>
      )}
    </FormDialog>
  );
}
