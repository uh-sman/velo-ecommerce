import type { Metadata } from "next";

import { CheckoutFlow } from "@/components/checkout/checkout-flow";
import { getSessionUser } from "@/lib/api-server";

export const metadata: Metadata = { title: "Checkout", robots: { index: false } };

export default async function CheckoutPage() {
  const user = await getSessionUser();
  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <CheckoutFlow accountEmail={user?.email ?? null} />
    </div>
  );
}
