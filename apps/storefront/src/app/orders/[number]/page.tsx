import type { Metadata } from "next";
import Link from "next/link";

import { OrderDetail } from "@/components/orders/order-detail";
import { serverClient } from "@/lib/api-server";

export const metadata: Metadata = { title: "Your order", robots: { index: false } };

/**
 * The signed link from emails and the confirmation page: the order, without
 * signing in. A signed-in owner reaches it without the token too.
 */
export default async function GuestOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ number: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { number } = await params;
  const token = (await searchParams)["token"];
  const { data } = await (
    await serverClient()
  ).GET("/api/v1/orders/{number}", {
    params: { path: { number }, query: typeof token === "string" ? { token } : {} },
    cache: "no-store",
  });

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      {data ? (
        <OrderDetail initial={data} />
      ) : (
        <div className="flex flex-col items-start gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">We could not open that order</h1>
          <p className="text-text-secondary">
            The link may be incomplete. Find it with your order number and email instead.
          </p>
          <Link href="/orders/lookup" className="underline underline-offset-4">
            Find my order
          </Link>
        </div>
      )}
    </div>
  );
}
