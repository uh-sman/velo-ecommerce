import type { Metadata } from "next";

import { PageHeader } from "@/components/page";
import { CustomerList } from "@/components/people/customer-list";
import { RequirePermission } from "@/components/people/shared";

export const metadata: Metadata = { title: "Customers" };

export default function CustomersPage() {
  return (
    <RequirePermission permission="customers:read" title="Customers">
      <PageHeader title="Customers" description="Everyone with an account, newest first." />
      <CustomerList />
    </RequirePermission>
  );
}
