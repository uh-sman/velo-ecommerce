import type { Metadata } from "next";

import { OrderDetail } from "@/components/orders/order-detail";

export const metadata: Metadata = { title: "Order" };

/** PAGE-SPECS.md §3.5: resolve anything about one order without a developer. */
export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OrderDetail id={id} />;
}
