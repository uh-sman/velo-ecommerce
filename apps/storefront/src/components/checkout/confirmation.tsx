"use client";

import { formatMoney, type Schema } from "@velo/api-client";
import { CircleCheckIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { OrderSummary } from "@/components/commerce/order-summary";
import { FormAlert } from "@/components/forms/fields";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { callApi } from "@/lib/api-browser";
import { forgetCheckout } from "@/lib/checkout-session";

type Checkout = Schema<"CheckoutView">;
type Phase = "loading" | "confirming" | "slow" | "confirmed" | "failed" | "missing";

/**
 * A failed payment is believed only once it has stayed failed this long. A
 * customer whose first card was declined and whose second succeeded lands
 * here before the worker has processed the success: for a few seconds the
 * server still shows the earlier decline, and that customer must not be told
 * their payment failed.
 */
export const FAILURE_GRACE_MS = 10_000;

/** PAGE-SPECS.md §1.4: every 2 s for 30 s, then every 5 s to 3 minutes. */
export function pollDelay(elapsedMs: number): number | null {
  if (elapsedMs < 30_000) return 2_000;
  if (elapsedMs < 180_000) return 5_000;
  return null;
}

function maskEmail(email: string): string {
  const [name = "", domain = ""] = email.split("@");
  return `${name.slice(0, 1)}***@${domain}`;
}

/*
 * This page creates nothing. It reads the checkout until the webhook-created
 * order appears (ADR-010). A delay that is ours is never presented as a
 * failure, and a customer whose payment succeeded is never told to pay again.
 */
export function Confirmation({
  checkoutId,
  redirectStatus,
}: {
  checkoutId: string | null;
  redirectStatus: string | null;
}) {
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [orderLink, setOrderLink] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>(checkoutId ? "loading" : "missing");
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!checkoutId) return;
    if (redirectStatus === "failed") {
      setPhase("failed");
      return;
    }
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;

    async function poll() {
      const outcome = await callApi((client) =>
        client.GET("/api/v1/checkout/{checkout_id}", {
          params: { path: { checkout_id: checkoutId ?? "" } },
        }),
      );
      if (!active) return;
      if (outcome.ok) {
        setCheckout(outcome.data);
        if (outcome.data.order_number) {
          forgetCheckout();
          setPhase("confirmed");
          return;
        }
        if (outcome.data.payment?.status === "failed" && Date.now() - started >= FAILURE_GRACE_MS) {
          setPhase("failed");
          return;
        }
      } else if (outcome.problem.status === 404) {
        setPhase("missing");
        return;
      }
      const delay = pollDelay(Date.now() - started);
      if (delay === null) {
        setPhase("slow");
        return;
      }
      setPhase((current) => (current === "loading" ? "confirming" : current));
      timer = setTimeout(() => void poll(), delay);
    }

    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [checkoutId, redirectStatus]);

  useEffect(() => {
    heading.current?.focus();
  }, [phase]);

  // The order's signed link, so "Track this order" works without an account.
  const number = checkout?.order_number ?? null;
  const email = checkout?.email ?? null;
  useEffect(() => {
    if (!number || !email) return;
    void callApi((client) =>
      client.POST("/api/v1/orders/lookup", { body: { number, email } }),
    ).then((outcome) => {
      if (outcome.ok && outcome.data.access_token) {
        setOrderLink(`/orders/${number}?token=${outcome.data.access_token}`);
      }
    });
  }, [number, email]);

  if (phase === "missing") {
    return (
      <div className="flex flex-col gap-4">
        <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold outline-none">
          We could not find this checkout
        </h1>
        <p className="text-text-secondary">
          If you paid, your confirmation email has the order number.
        </p>
        <Button asChild className="self-start">
          <Link href="/">Continue shopping</Link>
        </Button>
      </div>
    );
  }

  if (phase === "failed") {
    return (
      <div className="flex flex-col gap-4">
        <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold outline-none">
          Payment not completed
        </h1>
        <FormAlert title="Your bank did not approve the payment">
          You have not been charged. Your items are still held for a few minutes — go back and try
          another card.
        </FormAlert>
        <Button asChild className="self-start">
          <Link href="/checkout">Back to payment</Link>
        </Button>
      </div>
    );
  }

  if (phase !== "confirmed" || !checkout?.order_number) {
    return (
      <div className="flex flex-col gap-4" aria-busy={phase !== "slow"}>
        <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold outline-none">
          {phase === "slow" ? "Your order is being finalised" : "Confirming your payment…"}
        </h1>
        <p role="status" className="text-text-secondary max-w-prose">
          {phase === "slow"
            ? "Your payment succeeded and your order is being finalised. You will get an email within 15 minutes."
            : "This takes a few seconds. Your payment has gone through — do not refresh or pay again."}
        </p>
        {phase !== "slow" && <Skeleton className="h-40" />}
      </div>
    );
  }

  const address = checkout.shipping_address;
  const firstName = address?.first_name;
  return (
    <div className="flex flex-col gap-8">
      <div role="status" className="flex flex-col items-center gap-2 text-center">
        <CircleCheckIcon className="text-success size-12" aria-hidden />
        <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold outline-none">
          Order confirmed{firstName ? ` — thank you, ${firstName}` : ""}
        </h1>
        <p className="text-lg">
          Order{" "}
          <span className="select-all font-mono text-2xl font-semibold">
            {checkout.order_number}
          </span>
        </p>
        <p className="text-text-secondary">
          A receipt is on its way to {maskEmail(checkout.email)}.
        </p>
      </div>

      <section
        aria-labelledby="next-heading"
        className="border-border-subtle rounded-lg border p-5"
      >
        <h2 id="next-heading" className="mb-3 font-semibold">
          What happens next
        </h2>
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
          <li>We pack your order (1–2 days).</li>
          <li>It ships — tracking arrives by email.</li>
          <li>
            It arrives
            {checkout.shipping_method?.est_days_max
              ? ` in about ${String(checkout.shipping_method.est_days_max)} business days`
              : ""}
            .
          </li>
        </ol>
      </section>

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <section aria-labelledby="items-heading" className="flex flex-col gap-3">
          <h2 id="items-heading" className="font-semibold">
            Items
          </h2>
          <ul className="divide-border-subtle divide-y text-sm">
            {checkout.items.map((item) => (
              <li key={item.variant_id} className="flex justify-between gap-4 py-3">
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
          {address && (
            <div className="text-sm">
              <h3 className="font-medium">Delivery address</h3>
              <address className="text-text-secondary not-italic">
                {address.first_name} {address.last_name}
                <br />
                {address.line1}
                {address.line2 ? `, ${address.line2}` : ""}
                <br />
                {[address.city, address.region, address.postal_code].filter(Boolean).join(", ")}
                <br />
                {address.country_code}
              </address>
            </div>
          )}
        </section>
        <OrderSummary
          totals={checkout.totals}
          itemCount={checkout.items.reduce((sum, item) => sum + item.quantity, 0)}
          discounts={checkout.discounts}
          shippingLabel={checkout.shipping_method?.name}
        />
      </div>

      <div className="flex flex-wrap gap-3">
        <Button asChild>
          <Link href={orderLink ?? `/orders/lookup`}>Track this order</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/">Continue shopping</Link>
        </Button>
      </div>
    </div>
  );
}
