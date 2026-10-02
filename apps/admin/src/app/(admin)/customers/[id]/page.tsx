import type { Metadata } from "next";

import { CustomerProfile } from "@/components/people/customer-profile";
import { RequirePermission } from "@/components/people/shared";

export const metadata: Metadata = { title: "Customer" };

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RequirePermission permission="customers:read" title="Customer">
      <CustomerProfile id={id} />
    </RequirePermission>
  );
}
