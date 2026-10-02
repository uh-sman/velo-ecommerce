import type { Metadata } from "next";
import { Suspense } from "react";

import { RecoverCart } from "@/components/email/recover-cart";

export const metadata: Metadata = { title: "Your cart", robots: { index: false } };

export default function RecoverCartPage() {
  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 px-4 py-16">
      <Suspense>
        <RecoverCart />
      </Suspense>
    </div>
  );
}
