import type { Metadata } from "next";

import { DiscountEditor } from "@/components/people/discount-builder";
import { RequirePermission } from "@/components/people/shared";

export const metadata: Metadata = { title: "Discount" };

export default async function DiscountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RequirePermission permission="discounts:write" title="Discount">
      <DiscountEditor id={id} />
    </RequirePermission>
  );
}
