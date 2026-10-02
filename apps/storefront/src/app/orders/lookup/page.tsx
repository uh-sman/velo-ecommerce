import type { Metadata } from "next";

import { OrderLookupForm } from "@/components/orders/order-lookup";

export const metadata: Metadata = { title: "Track an order" };

export default function OrderLookupPage() {
  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 px-4 py-16">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Track an order</h1>
        <p className="text-text-secondary mt-1">
          Enter your order number (it starts with VLO-) and the email you ordered with.
        </p>
      </div>
      <OrderLookupForm />
    </div>
  );
}
