import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-4 px-4 py-24 text-center">
      <p className="text-text-tertiary text-sm font-medium">404</p>
      <h1 className="text-2xl font-semibold tracking-tight">We could not find that page</h1>
      <p className="text-text-secondary">
        It may have moved, or the product may no longer be sold. Search, or start from the latest
        arrivals.
      </p>
      <div className="flex flex-wrap justify-center gap-3">
        <Button asChild>
          <Link href="/products">Shop new arrivals</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/">Home</Link>
        </Button>
      </div>
    </div>
  );
}
