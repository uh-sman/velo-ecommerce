import type { Metadata } from "next";

import { InventoryTable } from "@/components/catalog/inventory-table";
import { PageHeader } from "@/components/page";

export const metadata: Metadata = { title: "Inventory" };

/** Stock levels; `?q=` and `?low_stock=1` arrive from the editor and the dashboard. */
export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[]; low_stock?: string | string[] }>;
}) {
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q : "";
  const low = params.low_stock === "1" || params.low_stock === "true";
  return (
    <>
      <PageHeader
        title="Inventory"
        description="Stock on hand, reserved by checkouts in progress, and available to sell."
      />
      <InventoryTable key={`${q}|${String(low)}`} initialQuery={q} initialLowStock={low} />
    </>
  );
}
