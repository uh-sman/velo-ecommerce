"use client";

import type { ProblemDetail, Schema } from "@velo/api-client";
import { ExternalLinkIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";

import { MediaManager } from "@/components/catalog/media-manager";
import {
  PRODUCT_STATUSES,
  ProductStatusBadge,
  problemMessage,
  productStatusLabel,
  selectClass,
  textareaClass,
  type ProductStatus,
} from "@/components/catalog/shared";
import {
  blankVariant,
  draftFromVariant,
  generateVariants,
  MAX_VARIANTS,
  OptionBuilder,
  optionsFromProduct,
  validateVariants,
  variantChanges,
  variantInput,
  VariantGrid,
  type OptionDraft,
  type VariantDraft,
  type VariantErrors,
  type VariantField,
} from "@/components/catalog/variant-matrix";
import { FieldError, FormAlert, TextField } from "@/components/forms/fields";
import { ErrorState, formatDateTime, PageHeader, Section } from "@/components/page";
import { useCan } from "@/components/shell/me-context";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ui/sonner";
import { callApi, fieldErrors } from "@/lib/api-browser";
import { cn } from "@/lib/utils";

type Product = Schema<"AdminProductView">;
type Media = Schema<"MediaView">;
type Category = Schema<"AdminCategoryView">;
type Collection = Schema<"AdminCollectionView">;

const STOREFRONT = process.env["NEXT_PUBLIC_STOREFRONT_URL"] ?? "http://localhost:3000";
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEO_TITLE_GUIDE = 60;
const SEO_DESCRIPTION_MAX = 320;

interface ProductForm {
  title: string;
  slug: string;
  subtitle: string;
  description: string;
  brand: string;
  status: ProductStatus;
  category: string;
  collections: string[];
  seoTitle: string;
  seoDescription: string;
}

type FormField = keyof ProductForm;

const EMPTY_FORM: ProductForm = {
  title: "",
  slug: "",
  subtitle: "",
  description: "",
  brand: "",
  status: "draft",
  category: "",
  collections: [],
  seoTitle: "",
  seoDescription: "",
};

/** API field names → the form's. */
const API_FIELD: Record<string, FormField> = {
  title: "title",
  slug: "slug",
  subtitle: "subtitle",
  description: "description",
  brand: "brand",
  status: "status",
  category: "category",
  collections: "collections",
  seo_title: "seoTitle",
  seo_description: "seoDescription",
};

const VARIANT_FIELD: Record<string, VariantField> = {
  sku: "sku",
  price: "price",
  compare_at: "compareAt",
  cost: "cost",
  stock: "stock",
  barcode: "barcode",
  options: "options",
};

function formFrom(product: Product): ProductForm {
  return {
    title: product.title,
    slug: product.slug,
    subtitle: product.subtitle ?? "",
    description: product.description ?? "",
    brand: product.brand ?? "",
    status: (PRODUCT_STATUSES as readonly string[]).includes(product.status)
      ? (product.status as ProductStatus)
      : "draft",
    category: product.category ?? "",
    collections: [...product.collections].sort(),
    seoTitle: product.seo_title ?? "",
    seoDescription: product.seo_description ?? "",
  };
}

function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
}

function orNull(value: string): string | null {
  return value.trim() || null;
}

/** The PATCH for the product's own fields, or null when nothing changed. */
function productChanges(form: ProductForm, product: Product): Schema<"ProductUpdate"> | null {
  const changes: Schema<"ProductUpdate"> = {};
  if (form.title.trim() !== product.title) changes.title = form.title.trim();
  if (!product.published_at && form.slug.trim() && form.slug.trim() !== product.slug) {
    changes.slug = form.slug.trim();
  }
  if (orNull(form.subtitle) !== product.subtitle) changes.subtitle = orNull(form.subtitle);
  if (orNull(form.description) !== product.description) {
    changes.description = orNull(form.description);
  }
  if (orNull(form.brand) !== product.brand) changes.brand = orNull(form.brand);
  if (form.status !== product.status) changes.status = form.status;
  if (orNull(form.category) !== product.category) changes.category = orNull(form.category);
  if (form.collections.join("|") !== [...product.collections].sort().join("|")) {
    changes.collections = form.collections;
  }
  if (orNull(form.seoTitle) !== product.seo_title) changes.seo_title = orNull(form.seoTitle);
  if (orNull(form.seoDescription) !== product.seo_description) {
    changes.seo_description = orNull(form.seoDescription);
  }
  return Object.keys(changes).length ? changes : null;
}

function validateForm(form: ProductForm): Partial<Record<FormField, string>> {
  const errors: Partial<Record<FormField, string>> = {};
  if (!form.title.trim()) errors.title = "Give the product a title.";
  else if (form.title.trim().length > 200) errors.title = "At most 200 characters.";
  if (form.slug.trim() && !SLUG.test(form.slug.trim())) {
    errors.slug = "Lowercase letters, digits and single hyphens only.";
  }
  if (form.seoDescription.length > SEO_DESCRIPTION_MAX) {
    errors.seoDescription = `At most ${String(SEO_DESCRIPTION_MAX)} characters.`;
  }
  return errors;
}

/** Split an API problem into product-field and per-variant errors. */
function splitProblem(
  problem: ProblemDetail,
  rows: VariantDraft[],
): {
  form: Partial<Record<FormField, string>>;
  variants: Record<string, VariantErrors>;
} {
  const form: Partial<Record<FormField, string>> = {};
  const variants: Record<string, VariantErrors> = {};
  const live = rows.filter((row) => !row.deleted);
  for (const [field, message] of Object.entries(fieldErrors(problem))) {
    const nested = /^variants\.(\d+)\.?([a-z_]*)/.exec(field);
    if (nested) {
      const row = live[Number(nested[1])];
      if (!row) continue;
      const target = VARIANT_FIELD[nested[2] ?? ""];
      variants[row.key] = { ...variants[row.key], [target ?? "row"]: message };
    } else if (field === "sku") {
      // "SKU X belongs to another variant." — find the row by its SKU.
      const row = live.find((r) => r.sku.trim() && problem.detail?.includes(r.sku.trim()));
      if (row) variants[row.key] = { ...variants[row.key], sku: message };
    } else if (API_FIELD[field]) {
      form[API_FIELD[field]] = message;
    }
  }
  return { form, variants };
}

function countErrors(
  form: Partial<Record<FormField, string>>,
  variants: Record<string, VariantErrors>,
): number {
  return (
    Object.values(form).filter(Boolean).length +
    Object.values(variants).reduce((sum, row) => sum + Object.values(row).filter(Boolean).length, 0)
  );
}

/*
 * PAGE-SPECS.md §3.3. Content on the left, publishing and organisation on
 * the right at `xl`; tabbed below. One Save covers the product's fields and
 * every variant change; images save as they are changed. The save bar sticks
 * to the bottom while there are unsaved changes, and leaving asks first.
 */
export function ProductEditor({ productId }: { productId: string | null }) {
  const router = useRouter();
  const canWrite = useCan("catalog:write");
  const [product, setProduct] = useState<Product | null>(null);
  const [loadProblem, setLoadProblem] = useState<ProblemDetail | null>(null);
  const [form, setForm] = useState<ProductForm>(EMPTY_FORM);
  const [options, setOptions] = useState<OptionDraft[]>([]);
  const [rows, setRows] = useState<VariantDraft[]>([]);
  const [media, setMedia] = useState<Media[]>([]);
  const [serverForm, setServerForm] = useState<Partial<Record<FormField, string>>>({});
  const [serverRows, setServerRows] = useState<Record<string, VariantErrors>>({});
  const [showValidation, setShowValidation] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"content" | "publishing">("content");
  const [slugTouched, setSlugTouched] = useState(false);

  const reset = useCallback((next: Product) => {
    setProduct(next);
    setForm(formFrom(next));
    setOptions(optionsFromProduct(next));
    setRows(next.variants.map(draftFromVariant));
    setMedia(next.media);
    setServerForm({});
    setServerRows({});
    setShowValidation(false);
    setFormError(null);
  }, []);

  const load = useCallback(async () => {
    if (!productId) return;
    setLoadProblem(null);
    const outcome = await callApi((client) =>
      client.GET("/api/v1/admin/products/{product_id}", {
        params: { path: { product_id: productId } },
      }),
    );
    if (outcome.ok) reset(outcome.data);
    else setLoadProblem(outcome.problem);
  }, [productId, reset]);

  useEffect(() => {
    void load();
  }, [load]);

  const currency = product?.variants[0]?.price.currency ?? "USD";

  const clientForm = validateForm(form);
  const clientRows = validateVariants(rows, options);
  const formErrors = showValidation ? { ...serverForm, ...clientForm } : serverForm;
  const rowErrors = showValidation ? mergeRowErrors(serverRows, clientRows) : serverRows;
  const blocking = countErrors(clientForm, clientRows);

  const dirty = useMemo(() => {
    if (!product) {
      return Boolean(form.title.trim() || form.description.trim() || rows.length);
    }
    return (
      productChanges(form, product) !== null ||
      rows.some((row) => row.id === null || row.deleted || variantChanges(row, options) !== null)
    );
  }, [form, product, rows, options]);

  useUnsavedGuard(dirty && !saving);

  const patchForm = (patch: Partial<ProductForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    setServerForm((current) => {
      const next = { ...current };
      for (const key of Object.keys(patch) as FormField[]) delete next[key];
      return next;
    });
  };

  const changeRows = (next: VariantDraft[]) => {
    setRows(next);
    setServerRows({});
  };

  // ── Saving ──────────────────────────────────────────────────────────────

  const create = async (status: ProductStatus) => {
    const live = rows.filter((row) => !row.deleted);
    const body: Schema<"ProductCreate"> = {
      title: form.title.trim(),
      status,
      subtitle: orNull(form.subtitle),
      description: orNull(form.description),
      brand: orNull(form.brand),
      category: orNull(form.category),
      seo_title: orNull(form.seoTitle),
      seo_description: orNull(form.seoDescription),
      collections: form.collections,
      variants: live.map((row) => variantInput(row, options, currency)),
      ...(form.slug.trim() ? { slug: form.slug.trim() } : {}),
    };
    const outcome = await callApi((client) => client.POST("/api/v1/admin/products", { body }));
    if (!outcome.ok) {
      const split = splitProblem(outcome.problem, rows);
      setServerForm(split.form);
      setServerRows(split.variants);
      setFormError(problemMessage(outcome.problem));
      return;
    }
    notify.success(`“${outcome.data.title}” created`);
    router.replace(`/products/${outcome.data.id}`);
  };

  const update = async (current: Product, status: ProductStatus) => {
    let latest: Product = current;
    const failedRows = new Map<string, VariantDraft>();
    const rowProblems: Record<string, VariantErrors> = {};
    let failures = 0;

    const record = (row: VariantDraft, problem: ProblemDetail) => {
      failures += 1;
      failedRows.set(row.key, row);
      const errors = fieldErrors(problem);
      const mapped: VariantErrors = {};
      for (const [field, message] of Object.entries(errors)) {
        const target = VARIANT_FIELD[field];
        if (target) mapped[target] = message;
      }
      if (Object.keys(mapped).length === 0) mapped.row = problemMessage(problem);
      rowProblems[row.key] = mapped;
    };

    // Variants first: publishing needs at least one to exist.
    for (const row of rows) {
      if (row.deleted && row.id) {
        const id = row.id;
        const outcome = await callApi((client) =>
          client.DELETE("/api/v1/admin/variants/{variant_id}", {
            params: { path: { variant_id: id } },
          }),
        );
        if (outcome.ok) latest = outcome.data;
        else record(row, outcome.problem);
      } else if (row.id && !row.deleted) {
        const changes = variantChanges(row, options);
        if (!changes) continue;
        const id = row.id;
        const outcome = await callApi((client) =>
          client.PATCH("/api/v1/admin/variants/{variant_id}", {
            params: { path: { variant_id: id } },
            body: changes,
          }),
        );
        if (outcome.ok) latest = outcome.data;
        else record(row, outcome.problem);
      } else if (!row.id && !row.deleted) {
        const outcome = await callApi((client) =>
          client.POST("/api/v1/admin/products/{product_id}/variants", {
            params: { path: { product_id: current.id } },
            body: variantInput(row, options, currency),
          }),
        );
        if (outcome.ok) latest = outcome.data;
        else record(row, outcome.problem);
      }
    }

    const changes = productChanges({ ...form, status }, latest);
    let productFailed: ProblemDetail | null = null;
    if (changes) {
      const outcome = await callApi((client) =>
        client.PATCH("/api/v1/admin/products/{product_id}", {
          params: { path: { product_id: current.id } },
          body: changes,
        }),
      );
      if (outcome.ok) latest = outcome.data;
      else productFailed = outcome.problem;
    }

    if (failures === 0 && !productFailed) {
      reset(latest);
      notify.success(
        status !== current.status && status === "active"
          ? "Saved and published"
          : status !== current.status && current.status === "active"
            ? "Saved and unpublished"
            : "Product saved",
      );
      router.refresh();
      return;
    }

    // Keep what failed as the operator left it; take the server's word for the rest.
    const merged: VariantDraft[] = latest.variants.map(
      (variant) => failedRows.get(variant.id) ?? draftFromVariant(variant),
    );
    for (const row of failedRows.values()) {
      if (row.id === null || !latest.variants.some((v) => v.id === row.id)) {
        if (!merged.some((m) => m.key === row.key)) merged.push(row);
      }
    }
    setProduct(latest);
    setRows(merged);
    setServerRows(rowProblems);
    if (productFailed) {
      setServerForm(splitProblem(productFailed, merged).form);
    } else {
      setForm(formFrom(latest));
    }
    const total = failures + (productFailed ? 1 : 0);
    const message = productFailed
      ? `The product details were not saved: ${problemMessage(productFailed)}`
      : `${String(failures)} variant change${failures === 1 ? "" : "s"} could not be saved.`;
    setFormError(
      total > 1 && productFailed
        ? `${message} ${String(failures)} variant changes also failed.`
        : message,
    );
    notify.error("Some changes were not saved");
  };

  const save = async (status: ProductStatus = form.status) => {
    setShowValidation(true);
    setFormError(null);
    if (blocking > 0) {
      setFormError(
        `${String(blocking)} problem${blocking === 1 ? "" : "s"} to fix before saving — marked below.`,
      );
      return;
    }
    setSaving(true);
    if (status !== form.status) setForm((current) => ({ ...current, status }));
    if (product) await update(product, status);
    else await create(status);
    setSaving(false);
  };

  const discard = () => {
    if (product) reset(product);
    else {
      setForm(EMPTY_FORM);
      setOptions([]);
      setRows([]);
      setShowValidation(false);
      setFormError(null);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────

  if (productId && loadProblem) {
    return (
      <>
        <PageHeader title="Product" />
        {loadProblem.status === 404 ? (
          <FormAlert title="This product does not exist, or was deleted.">
            <Link href="/products" className="underline">
              Back to products
            </Link>
          </FormAlert>
        ) : (
          <ErrorState
            title={`We could not load this product. ${problemMessage(loadProblem)}`}
            onRetry={() => void load()}
          />
        )}
      </>
    );
  }
  if (productId && !product) return <EditorSkeleton />;

  const generate = () => {
    const result = generateVariants(options, rows, form.slug || slugify(form.title));
    changeRows(result.rows);
    if (result.capped) {
      notify.warning(`A product can have at most ${String(MAX_VARIANTS)} variants.`);
    } else if (result.added === 0) {
      notify.info("Every combination already has a variant.");
    } else {
      notify.success(`${String(result.added)} variant${result.added === 1 ? "" : "s"} added`);
    }
  };

  const published = Boolean(product?.published_at);
  const slugShown = form.slug || (slugTouched ? "" : slugify(form.title));

  return (
    <div className="flex flex-col gap-4 pb-24">
      <PageHeader
        title={product ? product.title : "New product"}
        description={
          product ? (
            <span className="flex flex-wrap items-center gap-2">
              <ProductStatusBadge status={product.status} />
              <span>Updated {formatDateTime(product.updated_at)}</span>
            </span>
          ) : (
            "Saved as a draft until you publish it."
          )
        }
        actions={
          <>
            {product?.status === "active" && (
              <Button asChild variant="outline">
                <a href={`${STOREFRONT}/products/${product.slug}`} target="_blank" rel="noreferrer">
                  View in store
                  <ExternalLinkIcon aria-hidden />
                </a>
              </Button>
            )}
            {canWrite && product && (
              <Button
                variant={product.status === "active" ? "outline" : "primary"}
                loading={saving}
                onClick={() => void save(product.status === "active" ? "draft" : "active")}
              >
                {product.status === "active"
                  ? dirty
                    ? "Save and unpublish"
                    : "Unpublish"
                  : dirty
                    ? "Save and publish"
                    : "Publish"}
              </Button>
            )}
          </>
        }
      />

      {formError && <FormAlert title={formError} />}

      <div role="tablist" aria-label="Editor sections" className="flex gap-1 xl:hidden">
        {(["content", "publishing"] as const).map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            id={`tab-${name}`}
            aria-selected={tab === name}
            aria-controls={`panel-${name}`}
            onClick={() => {
              setTab(name);
            }}
            className={cn(
              "min-h-11 rounded-md px-4 text-sm font-medium",
              tab === name ? "bg-secondary text-secondary-foreground" : "text-text-secondary",
            )}
          >
            {name === "content" ? "Content" : "Publishing & SEO"}
          </button>
        ))}
      </div>

      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]"
      >
        <fieldset
          id="panel-content"
          role="tabpanel"
          aria-labelledby="tab-content"
          disabled={!canWrite}
          className={cn("flex min-w-0 flex-col gap-6", tab !== "content" && "hidden xl:flex")}
        >
          <Section title="Details">
            <div className="flex flex-col gap-4">
              <TextField
                label="Title"
                value={form.title}
                maxLength={200}
                error={formErrors.title}
                onChange={(event) => {
                  patchForm({ title: event.target.value });
                }}
              />
              <TextField
                label="Subtitle"
                optional
                value={form.subtitle}
                maxLength={200}
                error={formErrors.subtitle}
                onChange={(event) => {
                  patchForm({ subtitle: event.target.value });
                }}
              />
              <TextArea
                label="Description"
                value={form.description}
                rows={8}
                maxLength={20000}
                error={formErrors.description}
                hint="Plain text; blank lines start new paragraphs."
                onChange={(value) => {
                  patchForm({ description: value });
                }}
              />
            </div>
          </Section>

          <Section title="Media">
            {product ? (
              <MediaManager
                productId={product.id}
                media={media}
                canWrite={canWrite}
                onChange={setMedia}
              />
            ) : (
              <p className="text-text-secondary text-sm">
                Save the product first, then add images.
              </p>
            )}
          </Section>

          <Section title="Variants">
            <div className="flex flex-col gap-5">
              <OptionBuilder
                options={options}
                onChange={setOptions}
                onGenerate={generate}
                disabled={!canWrite}
              />
              <VariantGrid
                rows={rows}
                options={options}
                currency={currency}
                errors={rowErrors}
                disabled={!canWrite}
                onChange={changeRows}
                onAdd={() => {
                  changeRows([
                    ...rows,
                    blankVariant(
                      {},
                      rows.find((row) => !row.deleted),
                    ),
                  ]);
                }}
              />
              {product && (
                <p className="text-text-secondary text-sm">
                  Stock for existing variants changes in{" "}
                  <Link href="/inventory" className="underline underline-offset-4">
                    Inventory
                  </Link>
                  , where every change needs a reason.
                </p>
              )}
            </div>
          </Section>
        </fieldset>

        <fieldset
          id="panel-publishing"
          role="tabpanel"
          aria-labelledby="tab-publishing"
          disabled={!canWrite}
          className={cn("flex min-w-0 flex-col gap-6", tab !== "publishing" && "hidden xl:flex")}
        >
          <Section title="Status">
            <div role="radiogroup" aria-label="Status" className="flex flex-col gap-1">
              {PRODUCT_STATUSES.map((status) => (
                <label
                  key={status}
                  className="grid min-h-11 grid-cols-[auto_1fr] items-center gap-x-3 py-1 text-sm"
                >
                  <input
                    type="radio"
                    name="status"
                    value={status}
                    checked={form.status === status}
                    className="accent-primary size-4"
                    onChange={() => {
                      patchForm({ status });
                    }}
                  />
                  <span className="font-medium">{productStatusLabel(status)}</span>
                  <span className="text-text-secondary col-start-2 text-xs">
                    {status === "draft"
                      ? "Hidden from the store."
                      : status === "active"
                        ? "Live in the store. Needs at least one variant."
                        : "Hidden, and kept out of the way."}
                  </span>
                </label>
              ))}
            </div>
            <FieldError id="status-error" message={formErrors.status} />
          </Section>

          <Organisation form={form} errors={formErrors} onChange={patchForm} />

          <Section title="Search engines">
            <div className="flex flex-col gap-4">
              <TextField
                label="URL handle"
                value={slugShown}
                maxLength={120}
                disabled={published}
                error={formErrors.slug}
                hint={
                  published
                    ? "Locked after the first publish, so links and search results keep working."
                    : product
                      ? "Lowercase letters, digits and hyphens."
                      : "Made from the title unless you change it."
                }
                onChange={(event) => {
                  setSlugTouched(true);
                  patchForm({ slug: event.target.value });
                }}
              />
              <TextField
                label="Page title"
                optional
                value={form.seoTitle}
                maxLength={200}
                error={formErrors.seoTitle}
                hint={`${String(form.seoTitle.length)} characters; about ${String(SEO_TITLE_GUIDE)} show in results.`}
                onChange={(event) => {
                  patchForm({ seoTitle: event.target.value });
                }}
              />
              <TextArea
                label="Meta description"
                optional
                value={form.seoDescription}
                rows={3}
                maxLength={SEO_DESCRIPTION_MAX}
                error={formErrors.seoDescription}
                hint={`${String(form.seoDescription.length)} of ${String(SEO_DESCRIPTION_MAX)} characters.`}
                onChange={(value) => {
                  patchForm({ seoDescription: value });
                }}
              />
              <SearchPreview
                title={form.seoTitle || form.title || "Product title"}
                url={`${STOREFRONT}/products/${slugShown || "…"}`}
                description={form.seoDescription || form.description}
              />
            </div>
          </Section>
        </fieldset>

        {canWrite && (dirty || !product) && (
          <div className="border-border-default bg-surface-raised sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-end gap-3 rounded-t-lg border p-3 shadow-md xl:col-span-2">
            <p className="text-text-secondary mr-auto text-sm" aria-live="polite">
              {showValidation && blocking > 0
                ? `${String(blocking)} problem${blocking === 1 ? "" : "s"} to fix`
                : product
                  ? "Unsaved changes"
                  : "New product"}
            </p>
            <Button type="button" variant="outline" onClick={discard} disabled={saving}>
              Discard
            </Button>
            <Button type="submit" loading={saving}>
              {showValidation && blocking > 0
                ? `Fix ${String(blocking)} error${blocking === 1 ? "" : "s"}`
                : product
                  ? "Save"
                  : "Create product"}
            </Button>
          </div>
        )}
      </form>
    </div>
  );
}

function mergeRowErrors(
  server: Record<string, VariantErrors>,
  client: Record<string, VariantErrors>,
): Record<string, VariantErrors> {
  const merged: Record<string, VariantErrors> = { ...server };
  for (const [key, errors] of Object.entries(client)) merged[key] = { ...merged[key], ...errors };
  return merged;
}

/** Warns before leaving with unsaved changes: closing the tab, or following an in-app link. */
function useUnsavedGuard(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === "_blank") return;
      const url = new URL(anchor.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) {
        return;
      }
      if (!window.confirm("You have unsaved changes. Leave without saving them?")) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", click, true);
    };
  }, [active]);
}

function TextArea({
  label,
  value,
  onChange,
  error,
  hint,
  optional,
  rows,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  hint?: ReactNode;
  optional?: boolean;
  rows: number;
  maxLength: number;
}) {
  const id = useId();
  const described = [hint !== undefined && `${id}-hint`, error && `${id}-error`]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
        {optional && <span className="text-text-tertiary font-normal"> (optional)</span>}
      </label>
      <textarea
        id={id}
        rows={rows}
        maxLength={maxLength}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={described || undefined}
        className={textareaClass}
        onChange={(event) => {
          onChange(event.target.value);
        }}
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

function Organisation({
  form,
  errors,
  onChange,
}: {
  form: ProductForm;
  errors: Partial<Record<FormField, string>>;
  onChange: (patch: Partial<ProductForm>) => void;
}) {
  const categoryId = useId();
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [collections, setCollections] = useState<Collection[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    const [cats, cols] = await Promise.all([
      callApi((client) => client.GET("/api/v1/admin/categories")),
      callApi((client) => client.GET("/api/v1/admin/collections")),
    ]);
    if (cats.ok) setCategories(cats.data);
    if (cols.ok) setCollections(cols.data);
    if (!cats.ok || !cols.ok) setFailed(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const categoryOptions = useMemo(() => {
    if (!categories) return [];
    const byId = new Map(categories.map((c) => [c.id, c]));
    const chain = (category: Category): string[] => {
      const parent = category.parent_id ? byId.get(category.parent_id) : undefined;
      return parent ? [...chain(parent), category.name] : [category.name];
    };
    return categories
      .map((category) => ({ slug: category.slug, label: chain(category).join(" › ") }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [categories]);

  return (
    <Section title="Organisation">
      <div className="flex flex-col gap-4">
        {failed && (
          <ErrorState title="Categories or collections did not load." onRetry={() => void load()} />
        )}
        <div className="flex flex-col gap-1.5">
          <label htmlFor={categoryId} className="text-sm font-medium">
            Category <span className="text-text-tertiary font-normal">(optional)</span>
          </label>
          {categories ? (
            <select
              id={categoryId}
              className={cn(selectClass, "w-full")}
              value={form.category}
              aria-invalid={errors.category ? true : undefined}
              onChange={(event) => {
                onChange({ category: event.target.value });
              }}
            >
              <option value="">No category</option>
              {categoryOptions.map((option) => (
                <option key={option.slug} value={option.slug}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <Skeleton className="h-10" />
          )}
          <FieldError id={`${categoryId}-error`} message={errors.category} />
        </div>

        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-sm font-medium">Collections</legend>
          {collections === null && !failed && <Skeleton className="h-20" />}
          {collections?.length === 0 && (
            <p className="text-text-secondary text-sm">No collections yet.</p>
          )}
          {collections?.map((collection) => {
            const checked = form.collections.includes(collection.slug);
            return (
              <div key={collection.id} className="flex min-h-11 items-center gap-3 text-sm">
                <Checkbox
                  id={`${categoryId}-${collection.id}`}
                  className="size-5"
                  checked={checked}
                  onCheckedChange={(next) => {
                    const set = new Set(form.collections);
                    if (next === true) set.add(collection.slug);
                    else set.delete(collection.slug);
                    onChange({ collections: [...set].sort() });
                  }}
                />
                <label htmlFor={`${categoryId}-${collection.id}`}>
                  {collection.title}
                  {!collection.is_active && (
                    <span className="text-text-tertiary text-xs"> (hidden)</span>
                  )}
                </label>
              </div>
            );
          })}
          <FieldError id={`${categoryId}-collections-error`} message={errors.collections} />
        </fieldset>

        <TextField
          label="Brand"
          optional
          value={form.brand}
          maxLength={120}
          error={errors.brand}
          onChange={(event) => {
            onChange({ brand: event.target.value });
          }}
        />
      </div>
    </Section>
  );
}

/** Roughly how a search result will read — so the title and description are judged in place. */
function SearchPreview({
  title,
  url,
  description,
}: {
  title: string;
  url: string;
  description: string;
}) {
  const text = description.replace(/\s+/g, " ").trim();
  return (
    <figure className="border-border-subtle rounded-md border p-3">
      <figcaption className="text-text-tertiary mb-2 text-xs uppercase tracking-wide">
        Search result preview
      </figcaption>
      <p className="text-text-secondary truncate text-xs">{url}</p>
      <p className="text-info truncate text-base">{title.slice(0, SEO_TITLE_GUIDE + 10)}</p>
      <p className="text-text-secondary line-clamp-2 text-sm">
        {text ? text.slice(0, 160) : "Add a meta description, or the store uses the description."}
      </p>
    </figure>
  );
}

function EditorSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy role="status" aria-label="Loading product">
      <Skeleton className="h-9 w-72" />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex flex-col gap-6">
          <Skeleton className="h-64" />
          <Skeleton className="h-40" />
          <Skeleton className="h-72" />
        </div>
        <div className="flex flex-col gap-6">
          <Skeleton className="h-40" />
          <Skeleton className="h-56" />
        </div>
      </div>
    </div>
  );
}
