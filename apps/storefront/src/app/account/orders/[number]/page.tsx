import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { OrderDetail } from "@/components/orders/order-detail";
import { serverClient } from "@/lib/api-server";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ number: string }>;
}): Promise<Metadata> {
  return { title: `Order ${(await params).number}` };
}

export default async function AccountOrderPage({
  params,
}: {
  params: Promise<{ number: string }>;
}) {
  const { number } = await params;
  const { data } = await (
    await serverClient()
  ).GET("/api/v1/orders/{number}", { params: { path: { number } }, cache: "no-store" });
  if (!data) notFound();
  return (
    <div className="flex flex-col gap-6">
      <Link href="/account/orders" className="text-sm underline underline-offset-4">
        ← All orders
      </Link>
      <OrderDetail initial={data} />
    </div>
  );
}
