import type { Metadata } from "next";
import { Suspense } from "react";

import { Unsubscribe } from "@/components/email/unsubscribe";

export const metadata: Metadata = { title: "Unsubscribe", robots: { index: false } };

export default function UnsubscribePage() {
  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 px-4 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Email preferences</h1>
      <Suspense>
        <Unsubscribe />
      </Suspense>
    </div>
  );
}
