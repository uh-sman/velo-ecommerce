import type { Metadata } from "next";

import { ProductListActions } from "@/components/catalog/product-list-actions";
import { ProductList } from "@/components/catalog/product-list";
import { PageHeader } from "@/components/page";

export const metadata: Metadata = { title: "Products" };

/** PAGE-SPECS.md §3.2. */
export default function ProductsPage() {
  return (
    <>
      <PageHeader
        title="Products"
        description="Everything in the catalog, drafts and archive included."
        actions={<ProductListActions />}
      />
      <ProductList />
    </>
  );
}
