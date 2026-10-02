import type { Metadata } from "next";

import { CartPage } from "@/components/commerce/cart-page";

export const metadata: Metadata = { title: "Your cart", robots: { index: false } };

export default function Cart() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <CartPage />
    </div>
  );
}
