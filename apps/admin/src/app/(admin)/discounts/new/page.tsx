import type { Metadata } from "next";

import { DiscountBuilder } from "@/components/people/discount-builder";
import { RequirePermission } from "@/components/people/shared";

export const metadata: Metadata = { title: "New discount" };

export default function NewDiscountPage() {
  return (
    <RequirePermission permission="discounts:write" title="New discount">
      <DiscountBuilder />
    </RequirePermission>
  );
}
