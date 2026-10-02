import type { Metadata } from "next";
import Link from "next/link";

import { ProductGrid } from "@/components/commerce/product-card";
import { Button } from "@/components/ui/button";
import { serverClient } from "@/lib/api-server";

export const metadata: Metadata = { title: "Wishlist" };

export default async function WishlistPage() {
  const { data } = await (
    await serverClient()
  ).GET("/api/v1/account/wishlist", { cache: "no-store" });
  const cards = data ?? [];
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Wishlist</h1>
      {cards.length === 0 ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-text-secondary">
            Nothing saved yet. Tap the heart on any product to keep it here.
          </p>
          <Button asChild>
            <Link href="/products">Browse new arrivals</Link>
          </Button>
        </div>
      ) : (
        <ProductGrid cards={cards} headingLevel="h2" />
      )}
    </div>
  );
}
