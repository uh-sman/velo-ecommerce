"use client";

import { formatMoney, type Schema } from "@velo/api-client";
import {
  Elements,
  ExpressCheckoutElement,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { LockIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { FormAlert } from "@/components/forms/fields";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { callApi, problemSlug } from "@/lib/api-browser";
import { AttemptKey } from "@/lib/idempotency";

type Checkout = Schema<"CheckoutView">;
type Intent = Schema<"PaymentIntentView">;
type Problem = { title: string; detail?: string | undefined } | null;

const stripes = new Map<string, Promise<Stripe | null>>();
function stripeFor(publishableKey: string) {
  let stripe = stripes.get(publishableKey);
  if (!stripe) {
    stripe = loadStripe(publishableKey);
    stripes.set(publishableKey, stripe);
  }
  return stripe;
}

function confirmationUrl(checkoutId: string): string {
  return `${window.location.origin}/checkout/confirmation?checkout=${checkoutId}`;
}

/*
 * Step 4. The server re-prices and creates the intent; the amount on the Pay
 * button is the server's. Card entry, 3-D Secure and wallets happen inside the
 * provider's iframe — no card field exists on our origin (PAYMENTS-AND-CHECKOUT
 * §9). Payment outcomes are page states, never toasts.
 */
export function PaymentStep({
  checkout,
  onRepriced,
  onProblem,
}: {
  checkout: Checkout;
  onRepriced: () => void;
  onProblem: (problem: Problem) => void;
}) {
  const [intent, setIntent] = useState<Intent | null>(null);
  const [error, setError] = useState<Problem>(null);
  const [pending, setPending] = useState(false);
  const attempt = useRef(new AttemptKey());

  async function start() {
    setPending(true);
    setError(null);
    const key = attempt.current.current;
    const outcome = await callApi((client) =>
      client.POST("/api/v1/checkout/{checkout_id}/payment-intent", {
        params: { path: { checkout_id: checkout.id } },
        headers: { "Idempotency-Key": key },
      }),
    );
    attempt.current.settle(outcome);
    setPending(false);
    if (outcome.ok) {
      setIntent(outcome.data);
      return;
    }
    const slug = problemSlug(outcome.problem);
    if (slug === "price-changed" || slug === "discount-expired") {
      // The checkout is already re-priced server-side: show the new total and ask again.
      onRepriced();
      setError({
        title:
          slug === "price-changed"
            ? "The total changed before we charged anything"
            : "Your discount code has run out",
        detail: "Check the updated order summary, then pay again. You have not been charged.",
      });
      return;
    }
    if (slug === "payments-unavailable") {
      setError({
        title: "Payments are temporarily unavailable",
        detail: "Your items are still held. Please try again in a few minutes.",
      });
      return;
    }
    onProblem({ title: outcome.problem.title, detail: outcome.problem.detail });
  }

  // A reload during payment resumes the intent already in flight — once per mount.
  const resumed = useRef(false);
  useEffect(() => {
    if (checkout.status === "payment_pending" && !resumed.current) {
      resumed.current = true;
      void start();
    }
  }, [checkout.status]);

  if (!intent) {
    return (
      <div className="flex flex-col gap-4">
        {error && <FormAlert title={error.title}>{error.detail}</FormAlert>}
        {checkout.status === "payment_pending" && pending ? (
          <Skeleton className="h-48" />
        ) : (
          <>
            <p className="text-sm">
              You will pay <strong>{formatMoney(checkout.totals.total)}</strong>. Card details are
              entered in our payment provider&apos;s secure form.
            </p>
            <Button size="lg" loading={pending} onClick={() => void start()} className="self-start">
              Continue to secure payment
            </Button>
          </>
        )}
        <TrustRow />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <Review checkout={checkout} intent={intent} />
      {intent.provider === "paystack" ? (
        <PaystackPayment intent={intent} checkoutId={checkout.id} />
      ) : (
        <StripePayment intent={intent} checkoutId={checkout.id} />
      )}
    </div>
  );
}

/*
 * The review (DESIGN-SYSTEM.md §5 "Checkout"): what is being bought, where it
 * goes, how, and the final total — the server's figure, the same one on the
 * Pay button — immediately before the customer commits.
 */
function Review({ checkout, intent }: { checkout: Checkout; intent: Intent }) {
  const address = checkout.shipping_address;
  const units = checkout.items.reduce((sum, item) => sum + item.quantity, 0);
  return (
    <section
      aria-labelledby="review-heading"
      className="bg-surface-sunken flex flex-col gap-2 rounded-md p-4 text-sm"
    >
      <h3 id="review-heading" className="font-semibold">
        Review your order
      </h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-text-secondary">Items</dt>
        <dd>
          {units} {units === 1 ? "item" : "items"}
        </dd>
        <dt className="text-text-secondary">Receipt to</dt>
        <dd className="break-all">{checkout.email}</dd>
        {address && (
          <>
            <dt className="text-text-secondary">Delivering to</dt>
            <dd>
              {address.first_name} {address.last_name}, {address.line1}, {address.city}
              {address.postal_code ? ` ${address.postal_code}` : ""}, {address.country_code}
            </dd>
          </>
        )}
        {checkout.shipping_method && (
          <>
            <dt className="text-text-secondary">Shipping</dt>
            <dd>{checkout.shipping_method.name}</dd>
          </>
        )}
        <dt className="font-semibold">Total</dt>
        <dd className="font-semibold tabular-nums">{formatMoney(intent.amount)}</dd>
      </dl>
    </section>
  );
}

function TrustRow() {
  return (
    <p className="text-text-secondary flex items-center gap-2 text-xs">
      <LockIcon className="size-3.5" aria-hidden />
      Encrypted and processed by our payment provider · 30-day returns · support@velo.dev
    </p>
  );
}

// ── Stripe ──────────────────────────────────────────────────────────────────

function StripePayment({ intent, checkoutId }: { intent: Intent; checkoutId: string }) {
  const stripe = useMemo(() => stripeFor(intent.publishable_key), [intent.publishable_key]);
  return (
    <Elements
      stripe={stripe}
      options={{
        clientSecret: intent.client_secret,
        appearance: {
          theme: "stripe",
          variables: { borderRadius: "6px", fontSizeBase: "16px" },
        },
      }}
    >
      <StripeForm intent={intent} checkoutId={checkoutId} />
    </Elements>
  );
}

function StripeForm({ intent, checkoutId }: { intent: Intent; checkoutId: string }) {
  const stripe = useStripe();
  const elements = useElements();
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [paying, setPaying] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function pay() {
    if (!stripe || !elements) return;
    setPaying(true);
    setMessage(null);
    const submitted = await elements.submit();
    if (submitted.error) {
      setPaying(false);
      setMessage(submitted.error.message ?? "Check your payment details.");
      return;
    }
    // 3-D Secure runs inside Stripe; a bank redirect comes back to return_url.
    const { error } = await stripe.confirmPayment({
      elements,
      clientSecret: intent.client_secret,
      confirmParams: { return_url: confirmationUrl(checkoutId) },
      redirect: "if_required",
    });
    if (error) {
      setPaying(false);
      setMessage(
        error.type === "card_error" || error.type === "validation_error"
          ? (error.message ?? "Your card was declined.")
          : "We could not complete the payment. You have not been charged — please try again.",
      );
      return;
    }
    router.push(`/checkout/confirmation?checkout=${checkoutId}`);
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Express wallets first (DESIGN-SYSTEM.md §5 "Checkout"). */}
      <ExpressCheckoutElement onConfirm={() => void pay()} />
      <PaymentElement
        onReady={() => {
          setReady(true);
        }}
        options={{ layout: "tabs" }}
      />
      {!ready && <Skeleton className="h-40" />}
      {message && <FormAlert title="Payment not completed">{message}</FormAlert>}
      <Button size="xl" onClick={() => void pay()} loading={paying} disabled={!ready || !stripe}>
        Pay {formatMoney(intent.amount)}
      </Button>
      <TrustRow />
    </div>
  );
}

// ── Paystack ────────────────────────────────────────────────────────────────

interface PaystackPop {
  resumeTransaction: (
    accessCode: string,
    callbacks: { onSuccess: () => void; onCancel: () => void; onError?: (e: unknown) => void },
  ) => void;
}

declare global {
  interface Window {
    PaystackPop?: new () => PaystackPop;
  }
}

function loadPaystack(): Promise<void> {
  if (window.PaystackPop) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://js.paystack.co/v2/inline.js";
    script.onload = () => {
      resolve();
    };
    script.onerror = () => {
      reject(new Error("paystack"));
    };
    document.head.append(script);
  });
}

function PaystackPayment({ intent, checkoutId }: { intent: Intent; checkoutId: string }) {
  const router = useRouter();
  const [paying, setPaying] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function pay() {
    setPaying(true);
    setMessage(null);
    try {
      await loadPaystack();
    } catch {
      setPaying(false);
      setMessage("We could not load the payment form. Check your connection and try again.");
      return;
    }
    const Pop = window.PaystackPop;
    if (!Pop) return;
    new Pop().resumeTransaction(intent.client_secret, {
      onSuccess: () => {
        router.push(`/checkout/confirmation?checkout=${checkoutId}`);
      },
      onCancel: () => {
        setPaying(false);
      },
      onError: () => {
        setPaying(false);
        setMessage("The payment did not go through. You have not been charged.");
      },
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {message && <FormAlert title="Payment not completed">{message}</FormAlert>}
      <Button size="xl" loading={paying} onClick={() => void pay()}>
        Pay {formatMoney(intent.amount)}
      </Button>
      <TrustRow />
    </div>
  );
}
