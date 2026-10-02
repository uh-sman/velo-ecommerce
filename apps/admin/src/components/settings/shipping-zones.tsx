"use client";

import { formatMoney, type Schema } from "@velo/api-client";
import { PencilIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { TextField } from "@/components/forms/fields";
import {
  EmptyState,
  ErrorState,
  Section,
  Table,
  toMajor,
  toMinor,
  td,
  th,
} from "@/components/page";
import { CheckField, problemMessage, useResource } from "@/components/people/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ui/sonner";
import { callApi } from "@/lib/api-browser";

import { FormDialog, type SubmitResult } from "./form-dialog";

type Zone = Schema<"ZoneView">;
type Rate = Schema<"RateView">;

/** `country_codes.2` → `country_codes`, so list errors land on their field. */
function collapse(errors: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, message] of Object.entries(errors)) {
    const base = key.split(".")[0] ?? key;
    out[base] ??= message;
  }
  return out;
}

function splitList(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function money(amount: number | null, currency: string): string {
  if (amount === null) return "";
  try {
    return formatMoney({ amount, currency });
  } catch {
    return `${toMajor(amount)} ${currency}`;
  }
}

function weight(grams: number): string {
  return grams >= 1000 ? `${String(grams / 1000)} kg` : `${String(grams)} g`;
}

/** "Orders $50.00+, up to 2 kg", in words an operator can check at a glance. */
function conditions(rate: Rate): string {
  const parts: string[] = [];
  const min = rate.min_subtotal_amount;
  const max = rate.max_subtotal_amount;
  if (min !== null && max !== null) {
    parts.push(`orders ${money(min, rate.currency)}–${money(max, rate.currency)}`);
  } else if (min !== null) parts.push(`orders ${money(min, rate.currency)} and up`);
  else if (max !== null) parts.push(`orders up to ${money(max, rate.currency)}`);
  const wMin = rate.min_weight_grams;
  const wMax = rate.max_weight_grams;
  if (wMin !== null && wMax !== null) parts.push(`${weight(wMin)}–${weight(wMax)}`);
  else if (wMin !== null) parts.push(`from ${weight(wMin)}`);
  else if (wMax !== null) parts.push(`up to ${weight(wMax)}`);
  const text = parts.join(", ");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Any order";
}

function days(rate: Rate): string {
  const { est_days_min: min, est_days_max: max } = rate;
  if (min !== null && max !== null)
    return min === max ? `${String(min)} days` : `${String(min)}–${String(max)} days`;
  if (max !== null) return `Up to ${String(max)} days`;
  if (min !== null) return `${String(min)}+ days`;
  return "—";
}

export function ShippingZones() {
  const { load, reload, mutate } = useResource(
    () => callApi((client) => client.GET("/api/v1/admin/shipping-zones")),
    "zones",
  );
  const settings = useResource(
    () => callApi((client) => client.GET("/api/v1/admin/settings")),
    "settings",
  );
  const storeCurrency =
    settings.load.state === "ready" && typeof settings.load.data.store["currency"] === "string"
      ? settings.load.data.store["currency"]
      : "USD";

  const [zoneDialog, setZoneDialog] = useState<{ zone: Zone | null } | null>(null);
  const [rateDialog, setRateDialog] = useState<{ zone: Zone; rate: Rate | null } | null>(null);

  function replaceZone(zone: Zone) {
    mutate((zones) => zones.map((item) => (item.id === zone.id ? zone : item)));
  }

  function replaceRate(rate: Rate) {
    mutate((zones) =>
      zones.map((zone) =>
        zone.id === rate.zone_id
          ? { ...zone, rates: zone.rates.map((item) => (item.id === rate.id ? rate : item)) }
          : zone,
      ),
    );
  }

  async function toggleZone(zone: Zone, active: boolean) {
    replaceZone({ ...zone, is_active: active });
    const outcome = await callApi((client) =>
      client.PATCH("/api/v1/admin/shipping-zones/{zone_id}", {
        params: { path: { zone_id: zone.id } },
        body: { is_active: active },
      }),
    );
    if (!outcome.ok) {
      replaceZone(zone);
      notify.error(problemMessage(outcome.problem));
      return;
    }
    replaceZone(outcome.data);
    notify.success(`${zone.name} ${active ? "is offered at checkout" : "is hidden from checkout"}`);
  }

  async function toggleRate(rate: Rate, active: boolean) {
    replaceRate({ ...rate, is_active: active });
    const outcome = await callApi((client) =>
      client.PATCH("/api/v1/admin/shipping-rates/{rate_id}", {
        params: { path: { rate_id: rate.id } },
        body: { is_active: active },
      }),
    );
    if (!outcome.ok) {
      replaceRate(rate);
      notify.error(problemMessage(outcome.problem));
      return;
    }
    replaceRate(outcome.data);
    notify.success(`${rate.name} ${active ? "switched on" : "switched off"}`);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-text-secondary text-sm">
          A zone is a set of countries; each zone offers one or more rates. A customer sees the
          active rates of the zone their address falls in.
        </p>
        <Button
          onClick={() => {
            setZoneDialog({ zone: null });
          }}
        >
          <PlusIcon aria-hidden />
          Add zone
        </Button>
      </div>

      {load.state === "loading" && (
        <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading shipping zones">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      )}
      {load.state === "error" && <ErrorState title={load.message} onRetry={reload} />}
      {load.state === "ready" && load.data.length === 0 && (
        <EmptyState title="No shipping zones yet">
          Without a zone, no address can check out. Add one for the countries you ship to.
        </EmptyState>
      )}
      {load.state === "ready" &&
        load.data.map((zone) => (
          <Section
            key={zone.id}
            title={
              <span className="flex flex-wrap items-center gap-2">
                {zone.name}
                {!zone.is_active && (
                  <span className="bg-surface-sunken text-text-secondary rounded-sm px-2 py-0.5 text-xs font-medium">
                    Inactive
                  </span>
                )}
              </span>
            }
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <CheckField
                  label="Active"
                  checked={zone.is_active}
                  onChange={(checked) => {
                    void toggleZone(zone, checked);
                  }}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setZoneDialog({ zone });
                  }}
                >
                  <PencilIcon aria-hidden />
                  Edit zone
                </Button>
              </div>
            }
          >
            <p className="text-text-secondary mb-3 text-sm">
              {zone.country_codes.join(", ")}
              {zone.regions && zone.regions.length > 0 && ` · regions: ${zone.regions.join(", ")}`}
            </p>
            {zone.rates.length === 0 ? (
              <p className="text-text-secondary mb-3 text-sm">
                No rates yet — customers in this zone cannot choose a shipping method.
              </p>
            ) : (
              <Table label={`Rates for ${zone.name}`}>
                <thead>
                  <tr>
                    <th scope="col" className={th}>
                      Rate
                    </th>
                    <th scope="col" className={`${th} text-right`}>
                      Price
                    </th>
                    <th scope="col" className={th}>
                      When
                    </th>
                    <th scope="col" className={th}>
                      Delivery
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
                  {zone.rates.map((rate) => (
                    <tr key={rate.id}>
                      <td className={td}>
                        <span className="block font-medium">{rate.name}</span>
                        {rate.description && (
                          <span className="text-text-secondary text-xs">{rate.description}</span>
                        )}
                      </td>
                      <td className={`${td} text-right tabular-nums`}>
                        {rate.price_amount === 0 ? "Free" : money(rate.price_amount, rate.currency)}
                      </td>
                      <td className={td}>{conditions(rate)}</td>
                      <td className={td}>{days(rate)}</td>
                      <td className={td}>
                        <CheckField
                          label={<span className="sr-only">{rate.name} active</span>}
                          checked={rate.is_active}
                          onChange={(checked) => {
                            void toggleRate(rate, checked);
                          }}
                        />
                      </td>
                      <td className={`${td} text-right`}>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setRateDialog({ zone, rate });
                          }}
                        >
                          Edit<span className="sr-only"> {rate.name}</span>
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => {
                setRateDialog({ zone, rate: null });
              }}
            >
              <PlusIcon aria-hidden />
              Add rate
            </Button>
          </Section>
        ))}

      {zoneDialog && (
        <ZoneDialog
          zone={zoneDialog.zone}
          onClose={() => {
            setZoneDialog(null);
          }}
          onSaved={(zone, created) => {
            if (created) mutate((zones) => [...zones, zone]);
            else replaceZone(zone);
            notify.success(created ? `${zone.name} added` : `${zone.name} saved`);
          }}
        />
      )}
      {rateDialog && (
        <RateDialog
          zone={rateDialog.zone}
          rate={rateDialog.rate}
          currency={storeCurrency}
          onClose={() => {
            setRateDialog(null);
          }}
          onSaved={(rate, created) => {
            if (created) {
              mutate((zones) =>
                zones.map((zone) =>
                  zone.id === rate.zone_id ? { ...zone, rates: [...zone.rates, rate] } : zone,
                ),
              );
            } else replaceRate(rate);
            notify.success(created ? `${rate.name} added` : `${rate.name} saved`);
          }}
        />
      )}
    </div>
  );
}

function ZoneDialog({
  zone,
  onClose,
  onSaved,
}: {
  zone: Zone | null;
  onClose: () => void;
  onSaved: (zone: Zone, created: boolean) => void;
}) {
  const [name, setName] = useState(zone?.name ?? "");
  const [countries, setCountries] = useState(zone?.country_codes.join(", ") ?? "");
  const [regions, setRegions] = useState(zone?.regions?.join(", ") ?? "");
  const [active, setActive] = useState(zone?.is_active ?? true);

  async function submit(): Promise<SubmitResult> {
    const codes = splitList(countries).map((code) => code.toUpperCase());
    if (codes.length === 0) {
      return { ok: false, errors: { country_codes: "Add at least one country code, such as US." } };
    }
    const regionList = regions
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const body = {
      name: name.trim(),
      country_codes: codes,
      regions: regionList.length > 0 ? regionList : null,
      is_active: active,
    };
    const outcome = zone
      ? await callApi((client) =>
          client.PATCH("/api/v1/admin/shipping-zones/{zone_id}", {
            params: { path: { zone_id: zone.id } },
            body,
          }),
        )
      : await callApi((client) => client.POST("/api/v1/admin/shipping-zones", { body }));
    if (!outcome.ok) return { ok: false, problem: outcome.problem };
    onSaved(outcome.data, zone === null);
    return { ok: true };
  }

  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={zone ? `Edit ${zone.name}` : "Add a shipping zone"}
      submitLabel={zone ? "Save zone" : "Add zone"}
      onSubmit={submit}
    >
      {(raw) => {
        const errors = collapse(raw);
        return (
          <div className="flex flex-col gap-4">
            <TextField
              label="Name"
              placeholder="Domestic"
              maxLength={120}
              value={name}
              error={errors["name"]}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
            <TextField
              label="Countries"
              placeholder="US, CA"
              hint="Two-letter country codes, separated by commas."
              autoCapitalize="characters"
              spellCheck={false}
              value={countries}
              error={errors["country_codes"]}
              onChange={(event) => {
                setCountries(event.target.value);
              }}
            />
            <TextField
              label="Regions"
              optional
              placeholder="CA, NY"
              hint="Limit the zone to these states or provinces, separated by commas."
              value={regions}
              error={errors["regions"]}
              onChange={(event) => {
                setRegions(event.target.value);
              }}
            />
            <CheckField label="Active" checked={active} onChange={setActive} />
          </div>
        );
      }}
    </FormDialog>
  );
}

function optionalMinor(value: string): number | null {
  return value.trim() ? toMinor(value) : null;
}

function optionalInt(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function asText(value: number | null): string {
  return value === null ? "" : String(value);
}

function RateDialog({
  zone,
  rate,
  currency,
  onClose,
  onSaved,
}: {
  zone: Zone;
  rate: Rate | null;
  currency: string;
  onClose: () => void;
  onSaved: (rate: Rate, created: boolean) => void;
}) {
  const rateCurrency = rate?.currency ?? currency;
  const [form, setForm] = useState({
    name: rate?.name ?? "",
    description: rate?.description ?? "",
    price: rate ? toMajor(rate.price_amount) : "",
    minSubtotal: toMajor(rate?.min_subtotal_amount),
    maxSubtotal: toMajor(rate?.max_subtotal_amount),
    minWeight: asText(rate?.min_weight_grams ?? null),
    maxWeight: asText(rate?.max_weight_grams ?? null),
    daysMin: asText(rate?.est_days_min ?? null),
    daysMax: asText(rate?.est_days_max ?? null),
    position: String(rate?.position ?? zone.rates.length),
    active: rate?.is_active ?? true,
  });
  type Key = keyof typeof form;

  function bind(key: Exclude<Key, "active">) {
    return {
      value: form[key],
      onChange: (event: { target: { value: string } }) => {
        setForm((current) => ({ ...current, [key]: event.target.value }));
      },
    };
  }

  async function submit(): Promise<SubmitResult> {
    const price = toMinor(form.price);
    if (price === null) return { ok: false, errors: { price_amount: "Enter a price; 0 is free." } };
    const fields = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      price_amount: price,
      min_subtotal_amount: optionalMinor(form.minSubtotal),
      max_subtotal_amount: optionalMinor(form.maxSubtotal),
      min_weight_grams: optionalInt(form.minWeight),
      max_weight_grams: optionalInt(form.maxWeight),
      est_days_min: optionalInt(form.daysMin),
      est_days_max: optionalInt(form.daysMax),
      is_active: form.active,
      position: optionalInt(form.position) ?? 0,
    };
    const outcome = rate
      ? await callApi((client) =>
          client.PATCH("/api/v1/admin/shipping-rates/{rate_id}", {
            params: { path: { rate_id: rate.id } },
            body: fields,
          }),
        )
      : await callApi((client) =>
          client.POST("/api/v1/admin/shipping-zones/{zone_id}/rates", {
            params: { path: { zone_id: zone.id } },
            body: { ...fields, currency: rateCurrency },
          }),
        );
    if (!outcome.ok) return { ok: false, problem: outcome.problem };
    onSaved(outcome.data, rate === null);
    return { ok: true };
  }

  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={rate ? `Edit ${rate.name}` : `Add a rate to ${zone.name}`}
      description={`Prices in ${rateCurrency}. Leave a condition blank to have no limit.`}
      submitLabel={rate ? "Save rate" : "Add rate"}
      onSubmit={submit}
    >
      {(errors) => (
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-[1fr_9rem]">
            <TextField
              label="Name"
              placeholder="Standard"
              maxLength={120}
              error={errors["name"]}
              {...bind("name")}
            />
            <TextField
              label="Price"
              inputMode="decimal"
              placeholder="0.00"
              error={errors["price_amount"]}
              {...bind("price")}
            />
          </div>
          <TextField
            label="Description"
            optional
            placeholder="Tracked, signed for"
            maxLength={500}
            error={errors["description"]}
            {...bind("description")}
          />
          <fieldset className="grid gap-4 sm:grid-cols-2">
            <legend className="mb-2 text-sm font-medium">Order subtotal</legend>
            <TextField
              label="From"
              optional
              inputMode="decimal"
              error={errors["min_subtotal_amount"]}
              {...bind("minSubtotal")}
            />
            <TextField
              label="Up to"
              optional
              inputMode="decimal"
              error={errors["max_subtotal_amount"]}
              {...bind("maxSubtotal")}
            />
          </fieldset>
          <fieldset className="grid gap-4 sm:grid-cols-2">
            <legend className="mb-2 text-sm font-medium">Parcel weight (grams)</legend>
            <TextField
              label="From"
              optional
              type="number"
              min={0}
              inputMode="numeric"
              error={errors["min_weight_grams"]}
              {...bind("minWeight")}
            />
            <TextField
              label="Up to"
              optional
              type="number"
              min={0}
              inputMode="numeric"
              error={errors["max_weight_grams"]}
              {...bind("maxWeight")}
            />
          </fieldset>
          <fieldset className="grid gap-4 sm:grid-cols-3">
            <legend className="mb-2 text-sm font-medium">Delivery estimate (days)</legend>
            <TextField
              label="Fastest"
              optional
              type="number"
              min={0}
              inputMode="numeric"
              error={errors["est_days_min"]}
              {...bind("daysMin")}
            />
            <TextField
              label="Slowest"
              optional
              type="number"
              min={0}
              inputMode="numeric"
              error={errors["est_days_max"]}
              {...bind("daysMax")}
            />
            <TextField
              label="Order shown"
              type="number"
              inputMode="numeric"
              hint="Lower first."
              error={errors["position"]}
              {...bind("position")}
            />
          </fieldset>
          <CheckField
            label="Active"
            checked={form.active}
            onChange={(checked) => {
              setForm((current) => ({ ...current, active: checked }));
            }}
          />
        </div>
      )}
    </FormDialog>
  );
}
