import type { Metadata } from "next";
import { Suspense } from "react";

import { ReturnsQueue } from "@/components/orders/returns-queue";
import { ListSkeleton } from "@/components/orders/order-list";

export const metadata: Metadata = { title: "Returns" };

/** The return (RMA) queue: decide, receive, refund and close returns. */
export default function ReturnsPage() {
  return (
    <Suspense fallback={<ListSkeleton />}>
      <ReturnsQueue />
    </Suspense>
  );
}
