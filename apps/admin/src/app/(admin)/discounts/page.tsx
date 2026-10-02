import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/page";
import { DiscountList } from "@/components/people/discount-list";
import { RequirePermission } from "@/components/people/shared";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Discounts" };

export default function DiscountsPage() {
  return (
    <RequirePermission permission="discounts:write" title="Discounts">
      <PageHeader
        title="Discounts"
        description="Codes and automatic discounts, newest first."
        actions={
          <Button asChild>
            <Link href="/discounts/new">New discount</Link>
          </Button>
        }
      />
      <DiscountList />
    </RequirePermission>
  );
}
