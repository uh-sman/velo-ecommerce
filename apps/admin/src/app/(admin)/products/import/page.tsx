import type { Metadata } from "next";

import { CsvImport } from "@/components/catalog/csv-import";
import { ExportButton } from "@/components/catalog/product-list-actions";
import { PageHeader } from "@/components/page";

export const metadata: Metadata = { title: "Import products" };

export default function ImportProductsPage() {
  return (
    <>
      <PageHeader
        title="Import products"
        description="Create and update products and variants from a CSV file."
        actions={<ExportButton label="Export current catalog" />}
      />
      <CsvImport />
    </>
  );
}
