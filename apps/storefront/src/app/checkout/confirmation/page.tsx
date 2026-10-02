import type { Metadata } from "next";

import { Confirmation } from "@/components/checkout/confirmation";

export const metadata: Metadata = { title: "Order confirmation", robots: { index: false } };

export default async function ConfirmationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : null);
  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <Confirmation
        checkoutId={one(params["checkout"])}
        redirectStatus={one(params["redirect_status"])}
      />
    </div>
  );
}
