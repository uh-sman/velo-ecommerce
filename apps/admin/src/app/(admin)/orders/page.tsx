import type { Metadata } from "next";
import { Suspense } from "react";

import { ListSkeleton, OrderList } from "@/components/orders/order-list";

export const metadata: Metadata = { title: "Orders" };

/** PAGE-SPECS.md §3.4. The list reads its filters from the URL, so it renders in the browser. */
export default function OrdersPage() {
  return (
    <Suspense fallback={<ListSkeleton />}>
      <OrderList />
    </Suspense>
  );
}
