"use client";

import Link from "next/link";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";

/**
 * A page failed to render. Never a blank screen and never a stack trace: say
 * what happened in plain words, offer a retry, and a way out. The digest is
 * what support needs to find the server-side log.
 */
export default function PageError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div
      role="alert"
      className="mx-auto flex max-w-xl flex-col items-center gap-4 px-4 py-24 text-center"
    >
      <h1 className="text-2xl font-semibold tracking-tight">Something went wrong on our side</h1>
      <p className="text-text-secondary">
        This is our fault, not yours. Try again — and if it keeps happening, email support@velo.dev
        {error.digest ? ` quoting ${error.digest}` : ""}. Your cart is saved.
      </p>
      <div className="flex flex-wrap justify-center gap-3">
        <Button onClick={reset}>Try again</Button>
        <Button asChild variant="outline">
          <Link href="/">Home</Link>
        </Button>
      </div>
    </div>
  );
}
