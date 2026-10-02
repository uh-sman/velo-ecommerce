import type { Metadata } from "next";

import { ProductEditor } from "@/components/catalog/product-editor";

export const metadata: Metadata = { title: "New product" };

/** PAGE-SPECS.md §3.3, for a product that does not exist yet. */
export default function NewProductPage() {
  return <ProductEditor productId={null} />;
}
