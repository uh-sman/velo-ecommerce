"use client";

import type { Schema } from "@velo/api-client";
import { CheckCircle2Icon, CircleDashedIcon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { FormAlert, TextField } from "@/components/forms/fields";
import { ErrorState, Section } from "@/components/page";
import { TextAreaField, problemMessage, useResource } from "@/components/people/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ui/sonner";
import { callApi, fieldErrors } from "@/lib/api-browser";
import { cn } from "@/lib/utils";

type Settings = Schema<"SettingsView">;

function str(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function useSettings() {
  return useResource(() => callApi((client) => client.GET("/api/v1/admin/settings")), "settings");
}

function FormSkeleton() {
  return (
    <div className="flex max-w-2xl flex-col gap-4" aria-busy="true" aria-label="Loading settings">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

/** Field errors keyed `address.2` gathered onto the one address field. */
function addressError(errors: Record<string, string>): string | undefined {
  const entry = Object.entries(errors).find(
    ([key]) => key === "address" || key.startsWith("address."),
  );
  if (!entry) return undefined;
  const line = Number(entry[0].split(".")[1]);
  return Number.isInteger(line) ? `Line ${String(line + 1)}: ${entry[1]}` : entry[1];
}

// ── Store details ────────────────────────────────────────────────────────────

export function StoreSettings() {
  const { load, reload, mutate } = useSettings();
  if (load.state === "loading") return <FormSkeleton />;
  if (load.state === "error") return <ErrorState title={load.message} onRetry={reload} />;
  return (
    <StoreForm
      store={load.data.store}
      onSaved={(store) => {
        mutate((current: Settings) => ({ ...current, store }));
      }}
    />
  );
}

function StoreForm({
  store,
  onSaved,
}: {
  store: Settings["store"];
  onSaved: (store: Settings["store"]) => void;
}) {
  const [name, setName] = useState(str(store["name"]));
  const [email, setEmail] = useState(str(store["support_email"]));
  const [phone, setPhone] = useState(str(store["phone"]));
  const [address, setAddress] = useState(
    Array.isArray(store["address"]) ? store["address"].map(str).join("\n") : "",
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const lines = address
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length > 6) {
      setErrors({ address: "At most 6 lines." });
      return;
    }
    setSaving(true);
    setProblem(null);
    setErrors({});
    const outcome = await callApi((client) =>
      client.PATCH("/api/v1/admin/settings/store", {
        body: {
          name: name.trim(),
          support_email: email.trim(),
          phone: phone.trim(),
          address: lines,
        },
      }),
    );
    setSaving(false);
    if (!outcome.ok) {
      const fields = fieldErrors(outcome.problem);
      setErrors(fields);
      if (Object.keys(fields).length === 0) setProblem(problemMessage(outcome.problem));
      return;
    }
    onSaved(outcome.data);
    notify.success("Store details saved");
  }

  const returnDays = str(store["return_window_days"]);
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <Section title="Store details">
        <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4">
          {problem && <FormAlert title={problem} />}
          <TextField
            label="Store name"
            maxLength={120}
            value={name}
            error={errors["name"]}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Support email"
              type="email"
              hint="Customers reply to this address."
              value={email}
              error={errors["support_email"]}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
            />
            <TextField
              label="Phone"
              optional
              type="tel"
              maxLength={40}
              value={phone}
              error={errors["phone"]}
              onChange={(event) => {
                setPhone(event.target.value);
              }}
            />
          </div>
          <TextAreaField
            label="Address"
            hint="One line per row, up to 6. Used as the return address."
            rows={5}
            value={address}
            error={addressError(errors)}
            onChange={(event) => {
              setAddress(event.target.value);
            }}
          />
          <div>
            <Button type="submit" loading={saving}>
              Save store details
            </Button>
          </div>
        </form>
      </Section>
      <Section title="Fixed settings">
        <dl className="flex flex-col gap-3 text-sm">
          <div>
            <dt className="text-text-secondary">Currency</dt>
            <dd className="font-medium">{str(store["currency"]) || "—"}</dd>
          </div>
          <div>
            <dt className="text-text-secondary">Return window</dt>
            <dd className="font-medium">{returnDays ? `${returnDays} days` : "—"}</dd>
          </div>
        </dl>
        <p className="text-text-secondary mt-3 text-sm">
          Prices are stored in the store currency, and both are set in the server environment, so
          they cannot be changed here.
        </p>
      </Section>
    </div>
  );
}

// ── Email texts ──────────────────────────────────────────────────────────────

export function EmailSettings() {
  const { load, reload, mutate } = useSettings();
  if (load.state === "loading") return <FormSkeleton />;
  if (load.state === "error") return <ErrorState title={load.message} onRetry={reload} />;
  return (
    <EmailForm
      emails={load.data.emails}
      storeName={str(load.data.store["name"])}
      onSaved={(emails) => {
        mutate((current: Settings) => ({ ...current, emails }));
      }}
    />
  );
}

function EmailForm({
  emails,
  storeName,
  onSaved,
}: {
  emails: Settings["emails"];
  storeName: string;
  onSaved: (emails: Settings["emails"]) => void;
}) {
  const [confirmed, setConfirmed] = useState(str(emails["order_confirmed_intro"]));
  const [shipped, setShipped] = useState(str(emails["order_shipped_intro"]));
  const [signature, setSignature] = useState(str(emails["signature"]));
  const [which, setWhich] = useState<"confirmed" | "shipped">("confirmed");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setProblem(null);
    setErrors({});
    const outcome = await callApi((client) =>
      client.PATCH("/api/v1/admin/settings/emails", {
        body: {
          order_confirmed_intro: confirmed.trim(),
          order_shipped_intro: shipped.trim(),
          signature: signature.trim(),
        },
      }),
    );
    setSaving(false);
    if (!outcome.ok) {
      const fields = fieldErrors(outcome.problem);
      setErrors(fields);
      if (Object.keys(fields).length === 0) setProblem(problemMessage(outcome.problem));
      return;
    }
    onSaved(outcome.data);
    notify.success("Email texts saved");
  }

  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <Section title="Words in customer emails">
        <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4">
          {problem && <FormAlert title={problem} />}
          <TextAreaField
            label="Order confirmed — opening line"
            maxLength={500}
            rows={3}
            value={confirmed}
            error={errors["order_confirmed_intro"]}
            onFocus={() => {
              setWhich("confirmed");
            }}
            onChange={(event) => {
              setConfirmed(event.target.value);
            }}
          />
          <TextAreaField
            label="Order shipped — opening line"
            maxLength={500}
            rows={3}
            value={shipped}
            error={errors["order_shipped_intro"]}
            onFocus={() => {
              setWhich("shipped");
            }}
            onChange={(event) => {
              setShipped(event.target.value);
            }}
          />
          <TextAreaField
            label="Signature"
            maxLength={500}
            rows={2}
            value={signature}
            error={errors["signature"]}
            onChange={(event) => {
              setSignature(event.target.value);
            }}
          />
          <div>
            <Button type="submit" loading={saving}>
              Save email texts
            </Button>
          </div>
        </form>
      </Section>
      <Section
        title="Preview"
        actions={
          <div role="group" aria-label="Which email" className="flex gap-1">
            {(["confirmed", "shipped"] as const).map((kind) => (
              <Button
                key={kind}
                type="button"
                size="sm"
                variant={which === kind ? "secondary" : "ghost"}
                aria-pressed={which === kind}
                onClick={() => {
                  setWhich(kind);
                }}
              >
                {kind === "confirmed" ? "Confirmed" : "Shipped"}
              </Button>
            ))}
          </div>
        }
      >
        <div className="bg-surface-page border-border-subtle rounded-md border p-4 text-sm leading-relaxed">
          <p className="text-text-secondary text-xs">
            From {storeName || "your store"} · Subject:{" "}
            {which === "confirmed" ? "Order #1042 confirmed" : "Order #1042 has shipped"}
          </p>
          <hr className="border-border-subtle my-3" />
          <p>Hi Alex,</p>
          <p className="mt-2 whitespace-pre-wrap">
            {(which === "confirmed" ? confirmed : shipped) || (
              <span className="text-text-tertiary">(no opening line)</span>
            )}
          </p>
          <p className="text-text-secondary mt-3">
            {which === "confirmed"
              ? "[Order #1042 — items, totals and delivery address]"
              : "[Tracking link and the items in this parcel]"}
          </p>
          <p className="mt-3 whitespace-pre-wrap">{signature}</p>
        </div>
        <p className="text-text-secondary mt-2 text-sm">
          The order details are filled in for each customer when the email is sent.
        </p>
      </Section>
    </div>
  );
}

// ── Payment providers ────────────────────────────────────────────────────────

const PROVIDER_NAMES: Record<string, string> = { stripe: "Stripe", paystack: "Paystack" };

export function PaymentProviders() {
  const { load, reload } = useSettings();
  if (load.state === "loading") {
    return (
      <div className="grid gap-4 md:grid-cols-2" aria-busy="true" aria-label="Loading providers">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (load.state === "error") return <ErrorState title={load.message} onRetry={reload} />;
  return (
    <div className="flex flex-col gap-4">
      <FormAlert tone="info" title="Keys live in the server environment">
        Payment keys are secrets, so they are never shown or edited here. To connect a provider or
        switch it to live mode, set its keys in the server environment and restart the API.
      </FormAlert>
      <div className="grid gap-4 md:grid-cols-2">
        {load.data.payment_providers.map((provider) => (
          <Section
            key={provider.name}
            title={
              <span className="flex items-center gap-2">
                {PROVIDER_NAMES[provider.name] ?? provider.name}
                {provider.default && (
                  <span className="bg-info/10 text-info rounded-sm px-2 py-0.5 text-xs font-medium">
                    Default
                  </span>
                )}
              </span>
            }
          >
            <dl className="flex flex-col gap-2 text-sm">
              <Row label="Connected" ok={provider.configured} />
              <Row label="Webhook" ok={provider.webhook_configured} />
              <div className="flex justify-between gap-3">
                <dt className="text-text-secondary">Mode</dt>
                <dd>
                  {provider.mode === "live" ? (
                    <span className="bg-success/10 text-success rounded-sm px-2 py-0.5 text-xs font-medium">
                      Live
                    </span>
                  ) : provider.mode === "test" ? (
                    <span className="bg-warning/10 text-warning rounded-sm px-2 py-0.5 text-xs font-medium">
                      Test — no real money moves
                    </span>
                  ) : (
                    "—"
                  )}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-text-secondary">Currencies</dt>
                <dd>
                  {provider.currencies.length > 0
                    ? provider.currencies.join(", ")
                    : provider.default
                      ? "All others (default)"
                      : "None routed"}
                </dd>
              </div>
            </dl>
          </Section>
        ))}
      </div>
    </div>
  );
}

function Row({ label, ok }: { label: string; ok: boolean }) {
  const Icon = ok ? CheckCircle2Icon : CircleDashedIcon;
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-text-secondary">{label}</dt>
      <dd className={cn("flex items-center gap-1.5", ok ? "text-success" : "text-text-secondary")}>
        <Icon className="size-4" aria-hidden />
        {ok ? "Configured" : "Not configured"}
      </dd>
    </div>
  );
}
