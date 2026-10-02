"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

import { refreshSession } from "@/lib/api-browser";

/**
 * Rendered when the server found no valid session. The refresh cookie only
 * reaches the API's refresh endpoint, so the browser renews the session and
 * re-renders — or, with nothing to renew, goes to sign-in and comes back.
 */
export function SessionGate() {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    let active = true;
    void refreshSession().then((ok) => {
      if (!active) return;
      if (ok) router.refresh();
      else router.replace(`/sign-in?next=${encodeURIComponent(pathname)}`);
    });
    return () => {
      active = false;
    };
  }, [pathname, router]);

  return (
    <p role="status" className="text-text-secondary px-4 py-16 text-center">
      Checking your session…
    </p>
  );
}
