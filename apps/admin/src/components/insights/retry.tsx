"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { ErrorState } from "@/components/page";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * A server-rendered block that failed to load. "Try again" re-renders the
 * route's Server Components, which re-requests only what the page needs.
 */
export function LoadError({ what, status }: { what: string; status?: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const title =
    status === 403 ? `You do not have access to ${what}.` : `We could not load ${what}.`;
  if (pending) return <Skeleton className="h-16 w-full" />;
  if (status === 403) return <ErrorState title={title} />;
  return (
    <ErrorState
      title={title}
      onRetry={() => {
        startTransition(() => {
          router.refresh();
        });
      }}
    />
  );
}
