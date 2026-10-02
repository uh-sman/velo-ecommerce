import type { Metadata } from "next";

import { OrderList } from "@/components/orders/order-list";

export const metadata: Metadata = { title: "Orders" };

export default function OrdersPage() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Orders</h1>
      <OrderList />
    </div>
  );
}
