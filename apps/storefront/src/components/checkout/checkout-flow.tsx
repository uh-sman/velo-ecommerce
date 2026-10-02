"use client";

import { formatMoney, type Schema } from "@velo/api-client";
import { CheckIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import {
  AddressForm,
  addressErrors,
  emptyAddress,
  type AddressDraft,
} from "@/components/checkout/address-form";
import { PaymentStep } from "@/components/checkout/payment-step";
import { OrderSummary } from "@/components/commerce/order-summary";
import { FormAlert, TextField } from "@/components/forms/fields";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { callApi, fieldErrors, problemSlug, type Outcome } from "@/lib/api-browser";
import { forgetCheckout, rememberCheckout, rememberedCheckout } from "@/lib/checkout-session";
import { AttemptKey } from "@/lib/idempotency";
import { cn } from "@/lib/utils";

type Checkout = Schema<"CheckoutView">;
type Address = Schema<"AddressOut">;
type Step = 1 | 2 | 3 | 4;

const STEPS: { step: Step; name: string }[] = [
  { step: 1, name: "Contact" },
  { step: 2, name: "Delivery" },
  { step: 3, name: "Shipping" },
  { step: 4, name: "Payment" },
];

/** The furthest step the server's state allows. */
function reachedStep(checkout: Checkout | null): Step {
  if (!checkout) return 1;
  switch (checkout.status) {
    case "initiated":
      return 2;
    case "address_set":
      return 3;
    default:
      return 4;
  }
}

/*
 * DESIGN-SYSTEM.md §5 "Checkout". The server's session is the state: every
 * step is a PATCH that returns the re-priced checkout, and the step shown is
 * derived from its status. The session id is remembered for the tab, so a
 * customer who navigates away comes back to the step they left.
 */
export function CheckoutFlow({ accountEmail }: { accountEmail: string | null }) {
  const router = useRouter();
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Step | null>(null);
  const [problem, setProblem] = useState<{ title: string; detail?: string | undefined } | null>(
    null,
  );
  const [expired, setExpired] = useState(false);

  const adopt = useCallback(
    (next: Checkout) => {
      if (next.status === "confirmed" || next.payment?.status === "succeeded") {
        router.replace(`/checkout/confirmation?checkout=${next.id}`);
        return;
      }
      if (next.status === "expired") {
        forgetCheckout();
        setExpired(true);
        setCheckout(null);
        return;
      }
      if (next.status === "abandoned" || next.status === "failed") {
        forgetCheckout();
        setCheckout(null);
        return;
      }
      rememberCheckout(next.id);
      setCheckout(next);
    },
    [router],
  );

  useEffect(() => {
    const id = rememberedCheckout();
    if (!id) {
      setLoading(false);
      return;
    }
    void callApi((client) =>
      client.GET("/api/v1/checkout/{checkout_id}", { params: { path: { checkout_id: id } } }),
    ).then((outcome) => {
      if (outcome.ok) adopt(outcome.data);
      else {
        if (outcome.problem.status === 410) setExpired(true);
        forgetCheckout();
      }
      setLoading(false);
    });
  }, [adopt]);

  /** Apply a step's outcome; true when it succeeded. */
  function handle(outcome: Outcome<Checkout>): boolean {
    if (outcome.ok) {
      setProblem(null);
      setEditing(null);
      adopt(outcome.data);
      return true;
    }
    if (outcome.problem.status === 410) {
      forgetCheckout();
      setExpired(true);
      setCheckout(null);
      return false;
    }
    setProblem({ title: outcome.problem.title, detail: outcome.problem.detail });
    return false;
  }

  async function refresh() {
    if (!checkout) return;
    const outcome = await callApi((client) =>
      client.GET("/api/v1/checkout/{checkout_id}", {
        params: { path: { checkout_id: checkout.id } },
      }),
    );
    handle(outcome);
  }

  if (loading) {
    return (
      <div className="grid gap-8 lg:grid-cols-[1fr_22rem]" aria-busy>
        <Skeleton className="h-96" />
        <Skeleton className="h-72" />
      </div>
    );
  }

  const reached = reachedStep(checkout);
  const current: Step = editing ?? reached;
  const paying = checkout?.status === "payment_pending";

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Checkout</h1>
        <StepIndicator
          current={current}
          reached={reached}
          locked={paying}
          onSelect={(step) => {
            setEditing(step === reached ? null : step);
          }}
        />
      </div>

      {expired && !checkout && (
        <FormAlert tone="info" title="Your checkout timed out">
          Items are held for 30 minutes. Your cart is still saved — start again to check the latest
          stock and prices.
        </FormAlert>
      )}
      {problem && <FormAlert title={problem.title}>{problem.detail}</FormAlert>}

      <div className="grid gap-8 lg:grid-cols-[1fr_22rem] lg:items-start">
        <div className="flex flex-col gap-4">
          <StepPanel
            step={1}
            current={current}
            title="Contact"
            summary={checkout?.email}
            onEdit={null}
          >
            <ContactStep
              accountEmail={accountEmail}
              onStarted={(started) => {
                setExpired(false);
                handle(started);
              }}
              onProblem={setProblem}
            />
          </StepPanel>

          <StepPanel
            step={2}
            current={current}
            title="Delivery"
            summary={checkout?.shipping_address ? oneLine(checkout.shipping_address) : undefined}
            onEdit={
              paying
                ? null
                : () => {
                    setEditing(2);
                  }
            }
          >
            {checkout && (
              <DeliveryStep checkout={checkout} signedIn={accountEmail !== null} onSaved={handle} />
            )}
          </StepPanel>

          <StepPanel
            step={3}
            current={current}
            title="Shipping"
            summary={
              checkout?.shipping_method
                ? `${checkout.shipping_method.name} · ${formatMoney(checkout.shipping_method.price)}`
                : undefined
            }
            onEdit={
              paying
                ? null
                : () => {
                    setEditing(3);
                  }
            }
          >
            {checkout && <ShippingStep checkout={checkout} onSaved={handle} />}
          </StepPanel>

          <StepPanel step={4} current={current} title="Payment" summary={undefined} onEdit={null}>
            {checkout && (
              <PaymentStep
                checkout={checkout}
                onRepriced={() => void refresh()}
                onProblem={setProblem}
              />
            )}
          </StepPanel>
        </div>

        {checkout && (
          <OrderSummary
            className="order-first lg:sticky lg:top-6 lg:order-none"
            totals={checkout.totals}
            itemCount={checkout.items.reduce((sum, item) => sum + item.quantity, 0)}
            discounts={checkout.discounts}
            shippingLabel={checkout.shipping_method?.name}
          >
            <ul className="border-border-subtle flex flex-col gap-3 border-t pt-4 text-sm">
              {checkout.items.map((item) => (
                <li key={item.variant_id} className="flex justify-between gap-3">
                  <span>
                    {item.product_title}
                    <span className="text-text-secondary block">
                      {item.variant_title} × {item.quantity}
                    </span>
                  </span>
                  <span className="tabular-nums">{formatMoney(item.line_total)}</span>
                </li>
              ))}
            </ul>
            <p className="text-text-secondary text-xs">
              Items are held until{" "}
              {new Date(checkout.expires_at).toLocaleTimeString(undefined, {
                hour: "numeric",
                minute: "2-digit",
              })}
              .
            </p>
          </OrderSummary>
        )}
      </div>
    </div>
  );
}

function oneLine(address: Address): string {
  return [
    `${address.first_name} ${address.last_name}`,
    address.line1,
    address.city,
    address.postal_code,
    address.country_code,
  ]
    .filter(Boolean)
    .join(", ");
}

/*
 * DESIGN-SYSTEM.md §4 "StepIndicator": all four steps always visible;
 * completed steps link back, future ones are aria-disabled; on phones,
 * "Step 2 of 4" and a bar instead of four cramped labels.
 */
function StepIndicator({
  current,
  reached,
  locked,
  onSelect,
}: {
  current: Step;
  reached: Step;
  locked: boolean;
  onSelect: (step: Step) => void;
}) {
  const name = STEPS[current - 1]?.name ?? "";
  return (
    <nav aria-label="Checkout progress">
      <div className="flex flex-col gap-2 sm:hidden">
        <p className="text-sm font-medium">
          Step {current} of 4 · {name}
        </p>
        <div className="bg-border-subtle h-1.5 overflow-hidden rounded-full">
          <div className="bg-primary h-full" style={{ width: `${String(current * 25)}%` }} />
        </div>
      </div>
      <ol className="hidden items-center gap-2 sm:flex">
        {STEPS.map(({ step, name: label }) => {
          const done = step < reached;
          const active = step === current;
          const clickable = step <= reached && step !== current && step > 1 && !locked;
          return (
            <li key={step} className="flex items-center gap-2">
              <button
                type="button"
                disabled={!clickable}
                aria-disabled={!clickable}
                aria-current={active ? "step" : undefined}
                onClick={() => {
                  onSelect(step);
                }}
                className={cn(
                  "flex h-11 items-center gap-2 rounded-md px-2 text-sm",
                  active ? "font-semibold" : "text-text-secondary",
                  clickable && "hover:bg-accent underline-offset-4 hover:underline",
                )}
              >
                <span
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full border text-xs",
                    active && "border-primary bg-primary text-primary-foreground",
                    done && !active && "border-success text-success",
                  )}
                  aria-hidden
                >
                  {done && !active ? <CheckIcon className="size-3.5" /> : step}
                </span>
                {label}
                {done && <span className="sr-only">(completed)</span>}
              </button>
              {step < 4 && <span className="bg-border-subtle h-px w-6" aria-hidden />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function StepPanel({
  step,
  current,
  title,
  summary,
  onEdit,
  children,
}: {
  step: Step;
  current: Step;
  title: string;
  summary: string | undefined;
  onEdit: (() => void) | null;
  children: React.ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const active = step === current;
  useEffect(() => {
    if (active && step > 1) heading.current?.focus();
  }, [active, step]);

  return (
    <section
      aria-labelledby={`step-${String(step)}`}
      className={cn("border-border-subtle rounded-lg border p-5", !active && "text-text-secondary")}
    >
      <div className="flex items-center justify-between gap-4">
        <h2
          id={`step-${String(step)}`}
          ref={heading}
          tabIndex={-1}
          className={cn("font-semibold outline-none", active && "text-text-primary text-lg")}
        >
          {step}. {title}
        </h2>
        {!active && summary && step < current && onEdit && (
          <Button variant="link" size="sm" onClick={onEdit}>
            Edit<span className="sr-only"> {title.toLowerCase()}</span>
          </Button>
        )}
      </div>
      {!active && summary && step < current && <p className="mt-1 text-sm">{summary}</p>}
      {active && <div className="mt-4">{children}</div>}
    </section>
  );
}

// ── Step 1: contact ─────────────────────────────────────────────────────────

function ContactStep({
  accountEmail,
  onStarted,
  onProblem,
}: {
  accountEmail: string | null;
  onStarted: (outcome: Outcome<Checkout>) => void;
  onProblem: (problem: { title: string; detail?: string | undefined } | null) => void;
}) {
  const [email, setEmail] = useState(accountEmail ?? "");
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const [shortages, setShortages] = useState<string[]>([]);
  const attempt = useRef(new AttemptKey());

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!accountEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("Enter an email address like name@example.com.");
      return;
    }
    setPending(true);
    setShortages([]);
    const key = attempt.current.current;
    const outcome = await callApi((client) =>
      client.POST("/api/v1/checkout", {
        body: accountEmail ? {} : { email },
        headers: { "Idempotency-Key": key },
      }),
    );
    attempt.current.settle(outcome);
    setPending(false);
    if (outcome.ok) {
      onStarted(outcome);
      return;
    }
    const slug = problemSlug(outcome.problem);
    if (slug === "out-of-stock") {
      setShortages(Object.values(fieldErrors(outcome.problem)));
      onProblem({
        title: "Some items sold out while you were shopping",
        detail: "Update your cart and try again.",
      });
    } else if (slug === "cart-empty") {
      onProblem({ title: "Your cart is empty", detail: "Add something before checking out." });
    } else {
      const field = fieldErrors(outcome.problem)["email"];
      if (field) setError(field);
      else onProblem({ title: outcome.problem.title, detail: outcome.problem.detail });
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
      {accountEmail ? (
        <p className="text-sm">
          Signed in as <strong>{accountEmail}</strong>. Your receipt goes here.
        </p>
      ) : (
        <>
          <TextField
            label="Email"
            type="email"
            autoComplete="email"
            inputMode="email"
            value={email}
            error={error}
            hint="For your receipt and delivery updates."
            onChange={(event) => {
              setEmail(event.target.value);
              if (error) setError(undefined);
            }}
          />
          <p className="text-text-secondary text-sm">
            Have an account?{" "}
            <Link href="/sign-in?next=/checkout" className="underline underline-offset-4">
              Sign in
            </Link>{" "}
            — or continue as a guest.
          </p>
        </>
      )}
      {shortages.length > 0 && (
        <ul className="text-danger list-disc pl-5 text-sm">
          {shortages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" loading={pending} size="lg">
          Continue to delivery
        </Button>
        {shortages.length > 0 && (
          <Button asChild variant="outline" size="lg">
            <Link href="/cart">Review cart</Link>
          </Button>
        )}
      </div>
    </form>
  );
}

// ── Step 2: delivery ────────────────────────────────────────────────────────

function DeliveryStep({
  checkout,
  signedIn,
  onSaved,
}: {
  checkout: Checkout;
  signedIn: boolean;
  onSaved: (outcome: Outcome<Checkout>) => boolean;
}) {
  const [shipping, setShipping] = useState<AddressDraft>(
    checkout.shipping_address
      ? { ...emptyAddress(), ...stringify(checkout.shipping_address) }
      : emptyAddress(),
  );
  const [billingSame, setBillingSame] = useState(
    checkout.billing_address === null ||
      JSON.stringify(checkout.billing_address) === JSON.stringify(checkout.shipping_address),
  );
  const [billing, setBilling] = useState<AddressDraft>(
    checkout.billing_address
      ? { ...emptyAddress(), ...stringify(checkout.billing_address) }
      : emptyAddress(),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState<Schema<"AddressResponse">[]>([]);

  useEffect(() => {
    if (!signedIn) return;
    void callApi((client) => client.GET("/api/v1/account/addresses"), {
      refreshOnExpiry: false,
    }).then((outcome) => {
      if (!outcome.ok) return;
      setSaved(outcome.data);
      const preferred = outcome.data.find((address) => address.is_default_shipping);
      if (preferred && !checkout.shipping_address) {
        setShipping({ ...emptyAddress(), ...stringify(preferred) });
      }
    });
  }, [signedIn, checkout.shipping_address]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const local = {
      ...prefix("shipping_address", addressErrors(shipping)),
      ...(billingSame ? {} : prefix("billing_address", addressErrors(billing))),
    };
    setErrors(local);
    if (Object.keys(local).length > 0) return;
    setPending(true);
    const outcome = await callApi((client) =>
      client.PATCH("/api/v1/checkout/{checkout_id}/address", {
        params: { path: { checkout_id: checkout.id } },
        body: {
          shipping_address: toBody(shipping),
          billing_address: billingSame ? null : toBody(billing),
        },
      }),
    );
    setPending(false);
    if (!outcome.ok) {
      const server = fieldErrors(outcome.problem);
      setErrors(server);
      if (Object.keys(server).length > 0) return;
    }
    onSaved(outcome);
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-6" noValidate>
      {saved.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">Saved addresses</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {saved.map((address) => (
              <button
                key={address.id}
                type="button"
                onClick={() => {
                  setShipping({ ...emptyAddress(), ...stringify(address) });
                }}
                className="border-border-default hover:bg-accent rounded-md border p-3 text-left text-sm"
              >
                <span className="font-medium">
                  {address.label ?? `${address.first_name} ${address.last_name}`}
                </span>
                <span className="text-text-secondary block">
                  {address.line1}, {address.city}, {address.country_code}
                </span>
              </button>
            ))}
          </div>
        </fieldset>
      )}
      <AddressForm
        legend="Shipping address"
        value={shipping}
        onChange={setShipping}
        errors={unprefix("shipping_address", errors)}
        autocompleteSection="shipping"
      />
      <label htmlFor="billing-same" className="flex min-h-11 items-center gap-3 text-sm">
        <Checkbox
          id="billing-same"
          checked={billingSame}
          onCheckedChange={(checked) => {
            setBillingSame(checked === true);
          }}
        />
        Billing address is the same as shipping
      </label>
      {!billingSame && (
        <AddressForm
          legend="Billing address"
          value={billing}
          onChange={setBilling}
          errors={unprefix("billing_address", errors)}
          autocompleteSection="billing"
        />
      )}
      <Button type="submit" loading={pending} size="lg" className="self-start">
        Continue to shipping
      </Button>
    </form>
  );
}

function stringify(
  address: Partial<Record<keyof AddressDraft, string | null | boolean>>,
): Partial<AddressDraft> {
  const out: Partial<AddressDraft> = {};
  for (const key of Object.keys(emptyAddress()) as (keyof AddressDraft)[]) {
    const value = address[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function toBody(draft: AddressDraft): Schema<"AddressIn"> {
  const optional = (value: string) => (value.trim() ? value.trim() : null);
  return {
    first_name: draft.first_name.trim(),
    last_name: draft.last_name.trim(),
    company: optional(draft.company),
    line1: draft.line1.trim(),
    line2: optional(draft.line2),
    city: draft.city.trim(),
    region: optional(draft.region),
    postal_code: optional(draft.postal_code),
    country_code: draft.country_code,
    phone: optional(draft.phone),
  };
}

function prefix(name: string, errors: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(errors).map(([key, value]) => [`${name}.${key}`, value]),
  );
}

function unprefix(name: string, errors: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(errors)) {
    if (key.startsWith(`${name}.`)) out[key.slice(name.length + 1)] = value;
  }
  return out;
}

// ── Step 3: shipping ────────────────────────────────────────────────────────

function ShippingStep({
  checkout,
  onSaved,
}: {
  checkout: Checkout;
  onSaved: (outcome: Outcome<Checkout>) => boolean;
}) {
  const [rates, setRates] = useState<Schema<"ShippingRatesView"> | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    void callApi((client) =>
      client.GET("/api/v1/checkout/{checkout_id}/shipping-rates", {
        params: { path: { checkout_id: checkout.id } },
      }),
    ).then((outcome) => {
      if (!outcome.ok) {
        setFailed(true);
        return;
      }
      setRates(outcome.data);
      setSelected(outcome.data.selected_id ?? outcome.data.options[0]?.id ?? null);
    });
  }, [checkout.id]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    const outcome = await callApi((client) =>
      client.PATCH("/api/v1/checkout/{checkout_id}/shipping", {
        params: { path: { checkout_id: checkout.id } },
        body: { shipping_rate_id: selected },
      }),
    );
    setPending(false);
    onSaved(outcome);
  }

  if (failed) return <FormAlert title="We could not load shipping options" />;
  if (!rates) return <Skeleton className="h-32" />;

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
      {rates.options.length === 0 ? (
        <p className="text-sm">Nothing in this order needs shipping.</p>
      ) : (
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Shipping method</legend>
          {rates.options.map((option) => (
            <label
              key={option.id}
              className={cn(
                "border-border-default flex min-h-14 cursor-pointer items-center gap-3 rounded-md border px-4 py-3",
                selected === option.id && "border-primary ring-primary/30 ring-2",
              )}
            >
              <input
                type="radio"
                name="shipping_rate"
                value={option.id}
                checked={selected === option.id}
                onChange={() => {
                  setSelected(option.id);
                }}
                className="accent-primary size-4"
              />
              <span className="flex-1">
                <span className="block font-medium">{option.name}</span>
                <span className="text-text-secondary text-sm">{deliveryEstimate(option)}</span>
              </span>
              <span className="font-medium tabular-nums">
                {option.price.amount === 0 ? "Free" : formatMoney(option.price)}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <Button type="submit" loading={pending} size="lg" className="self-start">
        Continue to payment
      </Button>
    </form>
  );
}

function deliveryEstimate(option: {
  est_days_min: number | null;
  est_days_max: number | null;
}): string {
  const { est_days_min: min, est_days_max: max } = option;
  if (min === null && max === null) return "Delivery time varies";
  if (min !== null && max !== null && min !== max) {
    return `${String(min)}–${String(max)} business days`;
  }
  const days = max ?? min ?? 0;
  return `${String(days)} business ${days === 1 ? "day" : "days"}`;
}
