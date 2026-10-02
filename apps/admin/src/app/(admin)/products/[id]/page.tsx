import type { Metadata } from "next";

import { ProductEditor } from "@/components/catalog/product-editor";

export const metadata: Metadata = { title: "Edit product" };

/*
 * PAGE-SPECS.md §3.3. The product loads in the browser rather than here: a
 * server render cannot refresh an expired access token, and the editor is a
 * working surface that refetches after every save anyway.
 */
export default async function EditProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProductEditor key={id} productId={id} />;
}
