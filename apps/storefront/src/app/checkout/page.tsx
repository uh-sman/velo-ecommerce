import type { Metadata } from "next";
import { preconnect } from "react-dom";

import { CheckoutFlow } from "@/components/checkout/checkout-flow";
import { getSessionUser } from "@/lib/api-server";

export const metadata: Metadata = { title: "Checkout", robots: { index: false } };

// The payment step loads Stripe.js or Paystack inline; warm both connections
// while the customer fills in the address, not when they reach the card form.
const PAYMENT_ORIGINS = [
  "https://js.stripe.com",
  "https://api.stripe.com",
  "https://js.paystack.co",
];

export default async function CheckoutPage() {
  for (const origin of PAYMENT_ORIGINS) preconnect(origin);
  const user = await getSessionUser();
  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <CheckoutFlow accountEmail={user?.email ?? null} />
    </div>
  );
}
