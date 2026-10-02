"use client";

import type { Schema } from "@velo/api-client";
import { ShuffleIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { FormAlert, TextField } from "@/components/forms/fields";
import { ConfirmDialog, ErrorState, PageHeader, Section, formatDateTime } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ui/sonner";
import { callApi, fieldErrors } from "@/lib/api-browser";

import { DiscountStatusBadge } from "./discount-list";
import { EligibilityTester, TargetPicker } from "./discount-pickers";
import {
  changedFields,
  describeDraft,
  draftFromView,
  draftToFields,
  emptyDraft,
  generateCode,
  workedExample,
  type AppliesTo,
  type DiscountType,
  type Draft,
  type Segment,
  type Target,
} from "./discount-rules";
import { CheckField, RadioGroup, SelectField, problemMessage } from "./shared";

type View = Schema<"DiscountView">;

const TYPES: { value: DiscountType; label: string; hint: string }[] = [
  { value: "percentage", label: "Percentage", hint: "A percent off the items it applies to." },
  { value: "fixed_amount", label: "Fixed amount", hint: "An amount off, spread across the items." },
  { value: "free_shipping", label: "Free shipping", hint: "The shipping charge is waived." },
  { value: "buy_x_get_y", label: "Buy X get Y", hint: "Buy some, get more free or cheaper." },
];

const APPLIES: { value: AppliesTo; label: string }[] = [
  { value: "all", label: "Entire order" },
  { value: "products", label: "Specific products" },
  { value: "collections", label: "Specific collections" },
];

const SEGMENTS: { value: Segment; label: string }[] = [
  { value: "all", label: "Everyone" },
  { value: "returning", label: "Returning customers (at least one paid order)" },
  { value: "subscribers", label: "Newsletter subscribers" },
  { value: "staff", label: "Staff only" },
];

function timezoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "your local time";
  }
}

/** Load an existing discount, with names for the products or collections it targets. */
async function loadDiscount(
  id: string,
): Promise<{ ok: true; view: View; labels: Target[] } | { ok: false; message: string }> {
  const outcome = await callApi((client) =>
    client.GET("/api/v1/admin/discounts/{discount_id}", { params: { path: { discount_id: id } } }),
  );
  if (!outcome.ok) return { ok: false, message: problemMessage(outcome.problem) };
  const view = outcome.data;
  let labels: Target[] = [];
  if (view.applies_to === "collections" && view.target_ids.length > 0) {
    const collections = await callApi((client) => client.GET("/api/v1/admin/collections"));
    if (collections.ok) {
      labels = collections.data.map((collection) => ({
        id: collection.id,
        label: collection.title,
      }));
    }
  } else if (view.applies_to === "products" && view.target_ids.length > 0) {
    const products = await Promise.all(
      view.target_ids.map((productId) =>
        callApi((client) =>
          client.GET("/api/v1/admin/products/{product_id}", {
            params: { path: { product_id: productId } },
          }),
        ),
      ),
    );
    labels = products.flatMap((product) =>
      product.ok ? [{ id: product.data.id, label: product.data.title }] : [],
    );
  }
  return { ok: true, view, labels };
}

export function DiscountEditor({ id }: { id: string }) {
  const [state, setState] = useState<
    | { state: "loading" }
    | { state: "error"; message: string }
    | { state: "ready"; view: View; labels: Target[] }
  >({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setState({ state: "loading" });
    void loadDiscount(id).then((result) => {
      if (!live) return;
      setState(
        result.ok
          ? { state: "ready", view: result.view, labels: result.labels }
          : { state: "error", message: result.message },
      );
    });
    return () => {
      live = false;
    };
  }, [id, attempt]);

  if (state.state === "loading") {
    return (
      <div aria-busy="true" aria-label="Loading discount">
        <Skeleton className="mb-6 h-8 w-64" />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
          <Skeleton className="h-[40rem] w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }
  if (state.state === "error") {
    return (
      <>
        <PageHeader title="Discount" />
        <ErrorState
          title={state.message}
          onRetry={() => {
            setAttempt((current) => current + 1);
          }}
        />
      </>
    );
  }
  return <DiscountBuilder view={state.view} labels={state.labels} />;
}

/** The builder: a form on the left; the rule in a sentence and a basket tester on the right. */
export function DiscountBuilder({ view, labels = [] }: { view?: View; labels?: Target[] }) {
  const router = useRouter();
  const [saved, setSaved] = useState<View | undefined>(view);
  const [initial, setInitial] = useState<Draft>(() =>
    view ? draftFromView(view, labels) : emptyDraft(),
  );
  const [draft, setDraft] = useState<Draft>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<{ title: string; detail?: string } | null>(null);
  const [saving, setSaving] = useState<"draft" | "active" | "save" | null>(null);
  const [confirmLive, setConfirmLive] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const editing = saved !== undefined;
  const redeemed = (saved?.times_redeemed ?? 0) > 0;
  const sentence = describeDraft(draft);
  const example = workedExample(draft);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    const apiKey = FIELD_OF[key];
    if (apiKey && errors[apiKey]) {
      setErrors((current) => {
        const next = { ...current };
        delete next[apiKey];
        return next;
      });
    }
  }

  function fail(outcomeProblem: Parameters<typeof fieldErrors>[0]) {
    const fields = fieldErrors(outcomeProblem);
    setErrors(fields);
    // The detail is the sentence (a 409 on a redeemed discount says why); the title is generic.
    setProblem({ title: problemMessage(outcomeProblem) });
  }

  async function create(active: boolean) {
    setSaving(active ? "active" : "draft");
    setProblem(null);
    const fields = { ...draftToFields(draft), is_active: active };
    const outcome = await callApi((client) =>
      client.POST("/api/v1/admin/discounts", { body: fields }),
    );
    setSaving(null);
    if (!outcome.ok) {
      fail(outcome.problem);
      return;
    }
    notify.success(active ? "Discount created and active" : "Discount saved as a draft");
    router.push(`/discounts/${outcome.data.id}`);
  }

  async function update(): Promise<string | null> {
    if (!saved) return null;
    const changes = changedFields(initial, draft);
    setSaving("save");
    setProblem(null);
    const outcome = await callApi((client) =>
      client.PATCH("/api/v1/admin/discounts/{discount_id}", {
        params: { path: { discount_id: saved.id } },
        body: changes as Schema<"DiscountPatch">,
      }),
    );
    setSaving(null);
    if (!outcome.ok) {
      fail(outcome.problem);
      return problemMessage(outcome.problem);
    }
    const next = draftFromView(outcome.data, draft.targets);
    setSaved(outcome.data);
    setInitial(next);
    setDraft(next);
    setErrors({});
    notify.success("Discount saved");
    return null;
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!saved) {
      void create(true);
      return;
    }
    if (Object.keys(changedFields(initial, draft)).length === 0) {
      notify.info("Nothing has changed.");
      return;
    }
    if (saved.status === "active") {
      setConfirmLive(true);
      return;
    }
    void update();
  }

  const title = saved ? saved.title : "New discount";
  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {title}
            {saved && <DiscountStatusBadge status={saved.status} />}
          </span>
        }
        description={
          saved
            ? `Used ${String(saved.times_redeemed)} ${saved.times_redeemed === 1 ? "time" : "times"} · created ${formatDateTime(saved.created_at)}`
            : "Build the rule, read it back, and test it on a sample basket before it goes live."
        }
        actions={
          saved && (
            <Button
              variant="outline"
              onClick={() => {
                setConfirmDelete(true);
              }}
            >
              <Trash2Icon aria-hidden />
              {redeemed ? "Deactivate" : "Delete"}
            </Button>
          )
        }
      />

      <form
        onSubmit={onSubmit}
        noValidate
        className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]"
      >
        <div className="flex min-w-0 flex-col gap-4">
          {problem && <FormAlert title={problem.title}>{problem.detail}</FormAlert>}
          {redeemed && (
            <FormAlert tone="info" title="This discount has been used">
              Its terms — type, value, currency, what it applies to and buy/get quantities — are
              fixed so past orders stay explainable. You can still change its code, title, limits,
              dates and whether it is active. To change the terms, deactivate it and create a new
              one.
            </FormAlert>
          )}

          <Section title="Discount">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="Title"
                hint="For staff, and shown to customers on the cart."
                maxLength={120}
                value={draft.title}
                error={errors["title"]}
                onChange={(event) => {
                  set("title", event.target.value);
                }}
              />
              <div className="flex flex-col gap-1.5">
                <div className="flex items-end gap-2">
                  <TextField
                    className="flex-1"
                    label="Code"
                    optional
                    placeholder="SPRING20"
                    autoCapitalize="characters"
                    spellCheck={false}
                    maxLength={32}
                    value={draft.code}
                    error={errors["code"]}
                    onChange={(event) => {
                      set("code", event.target.value.toUpperCase());
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className={errors["code"] ? "mb-7" : ""}
                    onClick={() => {
                      set("code", generateCode());
                    }}
                  >
                    <ShuffleIcon aria-hidden />
                    Generate
                  </Button>
                </div>
                <p className="text-text-secondary text-sm">
                  {draft.code.trim()
                    ? "Customers enter this code at checkout. Letters, numbers, - and _."
                    : "Blank: an automatic discount, applied to every cart that qualifies."}
                </p>
              </div>
            </div>
          </Section>

          <Section title="Value">
            <div className="flex flex-col gap-4">
              <RadioGroup
                legend="Type"
                name="type"
                value={draft.type}
                options={TYPES.map((type) => ({
                  value: type.value,
                  label: type.label,
                  hint: type.hint,
                }))}
                error={errors["type"]}
                onChange={(value) => {
                  set("type", value);
                }}
              />
              <ValueFields draft={draft} errors={errors} set={set} />
            </div>
          </Section>

          <Section title="Applies to">
            <div className="flex flex-col gap-4">
              <RadioGroup
                legend="Which items"
                name="applies"
                inline
                value={draft.appliesTo}
                options={APPLIES}
                error={errors["applies_to"]}
                onChange={(value) => {
                  setDraft((current) => ({
                    ...current,
                    appliesTo: value,
                    targets: value === current.appliesTo ? current.targets : [],
                  }));
                }}
              />
              {draft.appliesTo !== "all" && (
                <TargetPicker
                  key={draft.appliesTo}
                  kind={draft.appliesTo}
                  targets={draft.targets}
                  error={errors["target_ids"]}
                  onChange={(targets) => {
                    set("targets", targets);
                  }}
                />
              )}
              <TextField
                label="Minimum order subtotal"
                optional
                inputMode="decimal"
                placeholder="0.00"
                hint={`In ${draft.currency || "the store currency"}, before shipping and tax. Blank: no minimum.`}
                className="max-w-xs"
                value={draft.minSubtotal}
                error={errors["min_subtotal_amount"]}
                onChange={(event) => {
                  set("minSubtotal", event.target.value);
                }}
              />
            </div>
          </Section>

          <Section title="Eligibility">
            <div className="flex flex-col gap-2">
              <SelectField
                label="Who can use it"
                className="max-w-md"
                value={draft.segment}
                error={errors["customer_segment"]}
                onChange={(event) => {
                  set("segment", event.target.value as Segment);
                }}
              >
                {SEGMENTS.map((segment) => (
                  <option key={segment.value} value={segment.value}>
                    {segment.label}
                  </option>
                ))}
              </SelectField>
              <CheckField
                label="First order only"
                hint="Refused to anyone with a paid order already."
                checked={draft.firstOrderOnly}
                onChange={(checked) => {
                  set("firstOrderOnly", checked);
                }}
              />
            </div>
          </Section>

          <Section title="Usage limits">
            <div className="flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  label="Total uses"
                  optional
                  type="number"
                  min={1}
                  inputMode="numeric"
                  hint="Blank: unlimited."
                  value={draft.maxRedemptions}
                  error={errors["max_redemptions"]}
                  onChange={(event) => {
                    set("maxRedemptions", event.target.value);
                  }}
                />
                <TextField
                  label="Uses per customer"
                  optional
                  type="number"
                  min={1}
                  inputMode="numeric"
                  hint="1: once per customer. Blank: unlimited."
                  value={draft.maxPerCustomer}
                  error={errors["max_per_customer"]}
                  onChange={(event) => {
                    set("maxPerCustomer", event.target.value);
                  }}
                />
              </div>
              <CheckField
                label="Combines with other discounts"
                hint="Off (the default): the customer gets whichever single discount saves them most."
                checked={draft.stackable}
                onChange={(checked) => {
                  set("stackable", checked);
                }}
              />
            </div>
          </Section>

          <Section title="Active dates">
            <div className="flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  label="Starts"
                  optional
                  type="datetime-local"
                  hint={
                    editing ? "Blank: keep the current start." : "Blank: as soon as it is saved."
                  }
                  value={draft.startsAt}
                  error={errors["starts_at"]}
                  onChange={(event) => {
                    set("startsAt", event.target.value);
                  }}
                />
                <TextField
                  label="Ends"
                  optional
                  type="datetime-local"
                  hint="Blank: no end date."
                  value={draft.endsAt}
                  error={errors["ends_at"]}
                  onChange={(event) => {
                    set("endsAt", event.target.value);
                  }}
                />
              </div>
              <p className="text-text-secondary text-sm">Times are in {timezoneName()}.</p>
              {editing && (
                <CheckField
                  label="Active"
                  hint="Switched off, it applies to nobody, whatever the dates say."
                  checked={draft.isActive}
                  onChange={(checked) => {
                    set("isActive", checked);
                  }}
                />
              )}
            </div>
          </Section>
        </div>

        <aside className="flex flex-col gap-4 lg:sticky lg:top-4" aria-label="Summary and test">
          <Section title="Summary">
            <p className="text-base leading-relaxed" aria-live="polite">
              “{sentence}”
            </p>
            {example && <p className="text-text-secondary mt-2 text-sm">{example}</p>}
            <div className="mt-4 flex flex-wrap gap-2">
              {editing ? (
                <Button type="submit" loading={saving === "save"}>
                  Save changes
                </Button>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    loading={saving === "draft"}
                    disabled={saving !== null}
                    onClick={() => {
                      void create(false);
                    }}
                  >
                    Save as draft
                  </Button>
                  <Button type="submit" loading={saving === "active"} disabled={saving !== null}>
                    Activate
                  </Button>
                </>
              )}
            </div>
          </Section>
          <Section title="Test it">
            <EligibilityTester draft={draft} />
          </Section>
        </aside>
      </form>

      {saved && (
        <>
          <ConfirmDialog
            open={confirmLive}
            onOpenChange={setConfirmLive}
            title="Change a live discount?"
            description="Carts already holding this discount are repriced with the new rule."
            confirmLabel="Save changes"
            onConfirm={update}
          >
            <div className="flex flex-col gap-3 text-sm">
              <div>
                <p className="text-text-secondary text-xs font-medium uppercase">Before</p>
                <p>{describeDraft(initial)}</p>
              </div>
              <div>
                <p className="text-text-secondary text-xs font-medium uppercase">After</p>
                <p>{sentence}</p>
              </div>
            </div>
          </ConfirmDialog>
          <ConfirmDialog
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            title={redeemed ? "Deactivate this discount?" : "Delete this discount?"}
            description={
              redeemed
                ? "It has been used, so it is kept for order history and switched off instead."
                : "It has never been used, so it is removed completely."
            }
            confirmLabel={redeemed ? "Deactivate" : "Delete"}
            tone="danger"
            onConfirm={async () => {
              const outcome = await callApi((client) =>
                client.DELETE("/api/v1/admin/discounts/{discount_id}", {
                  params: { path: { discount_id: saved.id } },
                }),
              );
              if (!outcome.ok) return problemMessage(outcome.problem);
              notify.success(
                outcome.data.outcome === "deleted"
                  ? "Discount deleted"
                  : "It had been used, so it was deactivated rather than deleted",
              );
              router.push("/discounts");
              return null;
            }}
          />
        </>
      )}
    </>
  );
}

/** Which API field each draft field maps to, for clearing its error on edit. */
const FIELD_OF: Partial<Record<keyof Draft, string>> = {
  code: "code",
  title: "title",
  type: "type",
  value: "value",
  currency: "currency",
  buyQuantity: "buy_quantity",
  getQuantity: "get_quantity",
  minSubtotal: "min_subtotal_amount",
  appliesTo: "applies_to",
  targets: "target_ids",
  segment: "customer_segment",
  maxRedemptions: "max_redemptions",
  maxPerCustomer: "max_per_customer",
  startsAt: "starts_at",
  endsAt: "ends_at",
};

function ValueFields({
  draft,
  errors,
  set,
}: {
  draft: Draft;
  errors: Record<string, string>;
  set: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
}): ReactNode {
  switch (draft.type) {
    case "percentage":
      return (
        <TextField
          label="Percent off"
          inputMode="decimal"
          placeholder="20"
          hint="A number from 0.01 to 100."
          className="max-w-xs"
          value={draft.value}
          error={errors["value"]}
          onChange={(event) => {
            set("value", event.target.value);
          }}
        />
      );
    case "fixed_amount":
      return (
        <div className="grid max-w-md gap-4 sm:grid-cols-[1fr_8rem]">
          <TextField
            label="Amount off"
            inputMode="decimal"
            placeholder="10.00"
            hint="Taken off the qualifying items, never below zero."
            value={draft.value}
            error={errors["value"]}
            onChange={(event) => {
              set("value", event.target.value);
            }}
          />
          <TextField
            label="Currency"
            maxLength={3}
            autoCapitalize="characters"
            spellCheck={false}
            hint="The store's currency."
            value={draft.currency}
            error={errors["currency"]}
            onChange={(event) => {
              set("currency", event.target.value.toUpperCase());
            }}
          />
        </div>
      );
    case "free_shipping":
      return (
        <p className="text-text-secondary text-sm">
          No value needed: the shipping charge is waived when the rule applies.
        </p>
      );
    case "buy_x_get_y":
      return (
        <div className="grid gap-4 sm:grid-cols-3">
          <TextField
            label="Customer buys"
            type="number"
            min={1}
            inputMode="numeric"
            placeholder="2"
            value={draft.buyQuantity}
            error={errors["buy_quantity"]}
            onChange={(event) => {
              set("buyQuantity", event.target.value);
            }}
          />
          <TextField
            label="And gets"
            type="number"
            min={1}
            inputMode="numeric"
            placeholder="1"
            value={draft.getQuantity}
            error={errors["get_quantity"]}
            onChange={(event) => {
              set("getQuantity", event.target.value);
            }}
          />
          <TextField
            label="Percent off what they get"
            inputMode="decimal"
            placeholder="100"
            hint="100: free."
            value={draft.value}
            error={errors["value"]}
            onChange={(event) => {
              set("value", event.target.value);
            }}
          />
        </div>
      );
  }
}
