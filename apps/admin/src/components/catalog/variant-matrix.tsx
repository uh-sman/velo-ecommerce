"use client";

import type { Schema } from "@velo/api-client";
import { PlusIcon, Trash2Icon, Undo2Icon, WandSparklesIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useId } from "react";

import { Badge, selectClass } from "@/components/catalog/shared";
import { FieldError } from "@/components/forms/fields";
import { toMajor, toMinor } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/*
 * The variant matrix (PAGE-SPECS.md §3.3): options × values generate the
 * variants, which are then edited inline as one grid — 24 variants are not
 * edited through 24 modals. Everything here is a draft; the editor's Save
 * turns it into API calls.
 */

type Variant = Schema<"AdminVariantView">;

export const MAX_OPTIONS = 3;
export const MAX_VARIANTS = 250;

export interface OptionDraft {
  key: string;
  name: string;
  /** Comma-separated as typed; parsed by `optionValues`. */
  values: string;
}

export interface VariantDraft {
  key: string;
  /** Null until the variant exists in the API. */
  id: string | null;
  options: Record<string, string>;
  sku: string;
  price: string; // major units, as typed
  compareAt: string;
  cost: string;
  barcode: string;
  /** Opening stock — new variants only. Later changes need a reason (Inventory). */
  stock: string;
  deleted: boolean;
  original: Variant | null;
}

export type VariantField = "sku" | "price" | "compareAt" | "cost" | "stock" | "barcode" | "options";
export type VariantErrors = Partial<Record<VariantField, string>> & { row?: string };

let sequence = 0;
export function newKey(prefix: string): string {
  sequence += 1;
  return `${prefix}-${String(sequence)}`;
}

export function optionValues(option: OptionDraft): string[] {
  const seen = new Set<string>();
  for (const part of option.values.split(",")) {
    const value = part.trim();
    if (value) seen.add(value);
  }
  return [...seen];
}

/** Options with a name and at least one value — the ones that shape variants. */
export function usableOptions(options: OptionDraft[]): { name: string; values: string[] }[] {
  return options
    .map((option) => ({ name: option.name.trim(), values: optionValues(option) }))
    .filter((option) => option.name && option.values.length > 0);
}

export function optionsFromProduct(product: Schema<"AdminProductView">): OptionDraft[] {
  return product.options.map((option) => ({
    key: newKey("option"),
    name: option.name,
    values: option.values.map((value) => value.value).join(", "),
  }));
}

export function draftFromVariant(variant: Variant): VariantDraft {
  return {
    key: variant.id,
    id: variant.id,
    options: { ...variant.option_values },
    sku: variant.sku,
    price: toMajor(variant.price.amount),
    compareAt: toMajor(variant.compare_at?.amount),
    cost: toMajor(variant.cost?.amount),
    barcode: variant.barcode ?? "",
    stock: String(variant.stock?.quantity_on_hand ?? 0),
    deleted: false,
    original: variant,
  };
}

export function blankVariant(
  options: Record<string, string>,
  template?: VariantDraft,
): VariantDraft {
  return {
    key: newKey("variant"),
    id: null,
    options,
    sku: "",
    price: template?.price ?? "",
    compareAt: template?.compareAt ?? "",
    cost: template?.cost ?? "",
    barcode: "",
    stock: "0",
    deleted: false,
    original: null,
  };
}

function comboKey(options: Record<string, string>, names: string[]): string {
  return names.map((name) => `${name}=${options[name] ?? ""}`).join("|");
}

function skuPart(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toUpperCase();
}

/**
 * Every combination of the options' values, as rows. Existing rows are kept
 * as they are; only missing combinations are added, with a suggested SKU
 * and the first row's prices as a starting point.
 */
export function generateVariants(
  options: OptionDraft[],
  rows: VariantDraft[],
  skuBase: string,
): { rows: VariantDraft[]; added: number; capped: boolean } {
  const usable = usableOptions(options);
  if (usable.length === 0) return { rows, added: 0, capped: false };
  let combos: Record<string, string>[] = [{}];
  for (const option of usable) {
    combos = combos.flatMap((combo) =>
      option.values.map((value) => ({ ...combo, [option.name]: value })),
    );
  }
  const names = usable.map((option) => option.name);
  const present = new Set(rows.filter((r) => !r.deleted).map((r) => comboKey(r.options, names)));
  const template = rows.find((row) => !row.deleted);
  const added: VariantDraft[] = [];
  let capped = false;
  for (const combo of combos) {
    if (present.has(comboKey(combo, names))) continue;
    if (rows.filter((r) => !r.deleted).length + added.length >= MAX_VARIANTS) {
      capped = true;
      break;
    }
    const row = blankVariant(combo, template);
    row.sku = [skuPart(skuBase), ...names.map((name) => skuPart(combo[name] ?? ""))]
      .filter(Boolean)
      .join("-");
    added.push(row);
  }
  return { rows: [...rows, ...added], added: added.length, capped };
}

export function variantLabel(row: VariantDraft, names: string[]): string {
  const values = names.map((name) => row.options[name]).filter(Boolean);
  return values.length ? values.join(" / ") : (row.original?.title ?? "Default");
}

/** Blocking problems, per row and field, before anything is sent. */
export function validateVariants(
  rows: VariantDraft[],
  options: OptionDraft[],
): Record<string, VariantErrors> {
  const usable = usableOptions(options);
  const names = usable.map((option) => option.name);
  const errors: Record<string, VariantErrors> = {};
  const skus = new Map<string, string>();
  const combos = new Map<string, string>();
  const add = (key: string, field: VariantField, message: string) => {
    errors[key] = { ...errors[key], [field]: message };
  };
  for (const row of rows) {
    if (row.deleted) continue;
    const sku = row.sku.trim();
    if (!sku) add(row.key, "sku", "Required.");
    else if (skus.has(sku.toLowerCase())) add(row.key, "sku", "Used by another variant here.");
    else skus.set(sku.toLowerCase(), row.key);

    const price = toMinor(row.price);
    if (!row.price.trim()) add(row.key, "price", "Required.");
    else if (price === null || !/^\d*\.?\d{0,2}$/.test(row.price.trim()))
      add(row.key, "price", "An amount such as 29.99.");
    if (row.compareAt.trim()) {
      const compare = toMinor(row.compareAt);
      if (compare === null) add(row.key, "compareAt", "An amount such as 39.99.");
      else if (price !== null && compare <= price)
        add(row.key, "compareAt", "Must exceed the price.");
    }
    if (row.cost.trim() && toMinor(row.cost) === null)
      add(row.key, "cost", "An amount such as 12.00.");
    if (row.id === null && !/^\d+$/.test(row.stock.trim())) {
      add(row.key, "stock", "A whole number, zero or more.");
    }
    const missing = names.filter((name) => !row.options[name]);
    if (missing.length) add(row.key, "options", `Choose ${missing.join(", ")}.`);
    else if (names.length) {
      const combo = comboKey(row.options, names);
      if (combos.has(combo)) add(row.key, "options", "Another variant has these options.");
      else combos.set(combo, row.key);
    }
  }
  return errors;
}

/** Only the options that still exist, so a renamed or removed option is not sent. */
export function currentOptions(row: VariantDraft, options: OptionDraft[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const option of usableOptions(options)) {
    const value = row.options[option.name];
    if (value) result[option.name] = value;
  }
  return result;
}

/** The body to create a variant. */
export function variantInput(
  row: VariantDraft,
  options: OptionDraft[],
  currency: string,
): Schema<"VariantInput"> {
  const opts = currentOptions(row, options);
  return {
    sku: row.sku.trim(),
    price: toMinor(row.price) ?? 0,
    currency,
    compare_at: row.compareAt.trim() ? toMinor(row.compareAt) : null,
    cost: row.cost.trim() ? toMinor(row.cost) : null,
    barcode: row.barcode.trim() || null,
    options: opts,
    stock: Number.parseInt(row.stock, 10) || 0,
    // The API's defaults, spelled out: the generated type marks them required.
    reorder_point: 5,
    track_inventory: true,
    allow_backorder: false,
    requires_shipping: true,
    is_taxable: true,
  };
}

/** The PATCH for an existing variant, or null when nothing changed. */
export function variantChanges(
  row: VariantDraft,
  options: OptionDraft[],
): Schema<"VariantUpdate"> | null {
  const original = row.original;
  if (!original || row.deleted) return null;
  const changes: Schema<"VariantUpdate"> = {};
  if (row.sku.trim() !== original.sku) changes.sku = row.sku.trim();
  const price = toMinor(row.price);
  if (price !== null && price !== original.price.amount) changes.price = price;
  const compare = row.compareAt.trim() ? toMinor(row.compareAt) : null;
  if (compare !== (original.compare_at?.amount ?? null)) changes.compare_at = compare;
  const cost = row.cost.trim() ? toMinor(row.cost) : null;
  if (cost !== (original.cost?.amount ?? null)) changes.cost = cost;
  const barcode = row.barcode.trim() || null;
  if (barcode !== original.barcode) changes.barcode = barcode;
  const opts = currentOptions(row, options);
  const before = original.option_values;
  const sameOptions =
    Object.keys(opts).length === Object.keys(before).length &&
    Object.entries(opts).every(([name, value]) => before[name] === value);
  if (!sameOptions) changes.options = opts;
  return Object.keys(changes).length ? changes : null;
}

/** Margin on price, from cost — computed live, never stored. */
function margin(row: VariantDraft): string {
  const price = toMinor(row.price);
  const cost = row.cost.trim() ? toMinor(row.cost) : null;
  if (!price || cost === null) return "—";
  return `${String(Math.round(((price - cost) / price) * 100))}%`;
}

// ── Option builder ────────────────────────────────────────────────────────

export function OptionBuilder({
  options,
  onChange,
  onGenerate,
  disabled,
}: {
  options: OptionDraft[];
  onChange: (options: OptionDraft[]) => void;
  onGenerate: () => void;
  disabled: boolean;
}) {
  const update = (key: string, patch: Partial<OptionDraft>) => {
    onChange(options.map((option) => (option.key === key ? { ...option, ...patch } : option)));
  };
  const total = usableOptions(options).reduce(
    (product, option) => product * option.values.length,
    1,
  );
  return (
    <fieldset className="flex flex-col gap-3" disabled={disabled}>
      <legend className="mb-1 text-sm font-medium">Options</legend>
      <p className="text-text-secondary -mt-1 text-sm">
        Such as Size or Colour. Values are separated by commas.
      </p>
      {options.map((option, index) => (
        <OptionRow
          key={option.key}
          index={index}
          option={option}
          onChange={(patch) => {
            update(option.key, patch);
          }}
          onRemove={() => {
            onChange(options.filter((o) => o.key !== option.key));
          }}
        />
      ))}
      <div className="flex flex-wrap gap-2">
        {options.length < MAX_OPTIONS && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              onChange([...options, { key: newKey("option"), name: "", values: "" }]);
            }}
          >
            <PlusIcon aria-hidden />
            Add an option
          </Button>
        )}
        {usableOptions(options).length > 0 && (
          <Button type="button" variant="secondary" size="sm" onClick={onGenerate}>
            <WandSparklesIcon aria-hidden />
            Generate variants ({total > MAX_VARIANTS ? `${String(MAX_VARIANTS)}+` : total})
          </Button>
        )}
      </div>
    </fieldset>
  );
}

function OptionRow({
  index,
  option,
  onChange,
  onRemove,
}: {
  index: number;
  option: OptionDraft;
  onChange: (patch: Partial<OptionDraft>) => void;
  onRemove: () => void;
}) {
  const id = useId();
  return (
    <div className="border-border-subtle flex flex-wrap items-end gap-2 rounded-md border p-3">
      <div className="flex w-40 flex-col gap-1.5">
        <label htmlFor={`${id}-name`} className="text-sm">
          Option {index + 1} name
        </label>
        <Input
          id={`${id}-name`}
          value={option.name}
          maxLength={120}
          placeholder="Size"
          onChange={(event) => {
            onChange({ name: event.target.value });
          }}
        />
      </div>
      <div className="flex min-w-48 flex-1 flex-col gap-1.5">
        <label htmlFor={`${id}-values`} className="text-sm">
          Values
        </label>
        <Input
          id={`${id}-values`}
          value={option.values}
          placeholder="S, M, L"
          onChange={(event) => {
            onChange({ values: event.target.value });
          }}
        />
      </div>
      <Button
        type="button"
        variant="ghost"
        size="lg"
        className="w-12 px-0"
        aria-label={`Remove option ${option.name || String(index + 1)}`}
        onClick={onRemove}
      >
        <XIcon aria-hidden />
      </Button>
    </div>
  );
}

// ── Variant grid ──────────────────────────────────────────────────────────

const cell = "border-border-subtle border-t px-2 py-2 align-top";
const head =
  "bg-surface-sunken text-text-secondary px-2 py-2 text-xs font-medium uppercase tracking-wide whitespace-nowrap";

export function VariantGrid({
  rows,
  options,
  currency,
  errors,
  disabled,
  onChange,
  onAdd,
}: {
  rows: VariantDraft[];
  options: OptionDraft[];
  currency: string;
  errors: Record<string, VariantErrors>;
  disabled: boolean;
  onChange: (rows: VariantDraft[]) => void;
  onAdd: () => void;
}) {
  const usable = usableOptions(options);
  const update = (key: string, patch: Partial<VariantDraft>) => {
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };
  if (rows.length === 0) {
    return (
      <div className="border-border-default flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center">
        <p className="text-sm font-medium">No variants yet</p>
        <p className="text-text-secondary text-sm">
          Generate them from options, or add a single variant for a product with no choices.
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onAdd} disabled={disabled}>
          <PlusIcon aria-hidden />
          Add a variant
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="border-border-subtle overflow-x-auto rounded-lg border">
        <table aria-label="Variants" className="w-full min-w-[60rem] text-left text-sm">
          <thead>
            <tr>
              {usable.map((option) => (
                <th key={option.name} className={head}>
                  {option.name}
                </th>
              ))}
              {usable.length === 0 && <th className={head}>Variant</th>}
              <th className={head}>SKU</th>
              <th className={head}>Price ({currency})</th>
              <th className={head}>Compare-at</th>
              <th className={head}>Cost</th>
              <th className={head}>Margin</th>
              <th className={head}>Barcode</th>
              <th className={head}>Stock</th>
              <th className={head}>
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <VariantRow
                key={row.key}
                row={row}
                options={usable}
                errors={errors[row.key] ?? {}}
                disabled={disabled}
                onChange={(patch) => {
                  update(row.key, patch);
                }}
                onRemove={() => {
                  if (row.id === null) onChange(rows.filter((r) => r.key !== row.key));
                  else update(row.key, { deleted: !row.deleted });
                }}
              />
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onAdd}
          disabled={disabled || rows.filter((r) => !r.deleted).length >= MAX_VARIANTS}
        >
          <PlusIcon aria-hidden />
          Add a variant
        </Button>
      </div>
    </div>
  );
}

function VariantRow({
  row,
  options,
  errors,
  disabled,
  onChange,
  onRemove,
}: {
  row: VariantDraft;
  options: { name: string; values: string[] }[];
  errors: VariantErrors;
  disabled: boolean;
  onChange: (patch: Partial<VariantDraft>) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const label = variantLabel(
    row,
    options.map((option) => option.name),
  );
  const inactive = disabled || row.deleted;
  const field = (
    name: Exclude<VariantField, "options">,
    title: string,
    props: { inputMode?: "decimal" | "numeric"; className?: string; placeholder?: string } = {},
  ) => (
    <td className={cell}>
      <Input
        id={`${id}-${name}`}
        aria-label={`${title}, ${label}`}
        aria-invalid={errors[name] ? true : undefined}
        aria-describedby={errors[name] ? `${id}-${name}-error` : undefined}
        value={row[name]}
        disabled={inactive}
        inputMode={props.inputMode}
        placeholder={props.placeholder}
        className={cn("h-10 min-w-24", props.className)}
        onChange={(event) => {
          onChange({ [name]: event.target.value });
        }}
      />
      <FieldError id={`${id}-${name}-error`} message={errors[name]} />
    </td>
  );
  return (
    <tr className={cn(row.deleted && "bg-danger/5")}>
      {options.map((option, index) => (
        <td key={option.name} className={cell}>
          <select
            aria-label={`${option.name}, variant ${label}`}
            className={cn(selectClass, "min-w-24")}
            value={row.options[option.name] ?? ""}
            disabled={inactive}
            aria-invalid={errors.options ? true : undefined}
            aria-describedby={errors.options && index === 0 ? `${id}-options-error` : undefined}
            onChange={(event) => {
              onChange({ options: { ...row.options, [option.name]: event.target.value } });
            }}
          >
            <option value="">Choose…</option>
            {option.values.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          {index === 0 && <FieldError id={`${id}-options-error`} message={errors.options} />}
          {index === 0 && row.deleted && (
            <p className="text-danger mt-1 text-xs">Deleted when you save</p>
          )}
          {index === 0 && row.id === null && !row.deleted && <Badge className="mt-1">New</Badge>}
        </td>
      ))}
      {options.length === 0 && (
        <td className={cn(cell, "whitespace-nowrap pt-4")}>
          {label}
          {row.id === null && <Badge className="ml-2">New</Badge>}
          {row.deleted && <p className="text-danger mt-1 text-xs">Deleted when you save</p>}
        </td>
      )}
      {field("sku", "SKU", { className: "min-w-36" })}
      {field("price", "Price", { inputMode: "decimal", placeholder: "0.00" })}
      {field("compareAt", "Compare-at price", { inputMode: "decimal" })}
      {field("cost", "Cost", { inputMode: "decimal" })}
      <td className={cn(cell, "text-text-secondary whitespace-nowrap pt-4 tabular-nums")}>
        {margin(row)}
      </td>
      {field("barcode", "Barcode", { className: "min-w-32" })}
      {row.id === null ? (
        field("stock", "Opening stock", { inputMode: "numeric", className: "w-20 min-w-20" })
      ) : (
        <td className={cn(cell, "whitespace-nowrap pt-3")}>
          <span className="tabular-nums">{row.original?.stock?.available ?? "—"}</span>
          <span className="text-text-tertiary text-xs"> available</span>
          <br />
          <Link
            href={`/inventory?q=${encodeURIComponent(row.original?.sku ?? row.sku)}`}
            className="text-primary text-xs underline underline-offset-4"
          >
            Adjust
          </Link>
        </td>
      )}
      <td className={cell}>
        <Button
          type="button"
          variant="ghost"
          size="lg"
          className="w-12 px-0"
          disabled={disabled}
          aria-label={row.deleted ? `Keep variant ${label}` : `Remove variant ${label}`}
          onClick={onRemove}
        >
          {row.deleted ? <Undo2Icon aria-hidden /> : <Trash2Icon aria-hidden />}
        </Button>
        {errors.row && <FieldError id={`${id}-row-error`} message={errors.row} />}
      </td>
    </tr>
  );
}
