"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

import { refreshSession } from "@/lib/api-browser";

/**
 * Rendered by a server page that found no valid access token.
 *
 * The refresh cookie only travels to the API's refresh endpoint, so the
 * server could not renew the session itself. The browser can: refresh, then
 * re-render the page signed in — or, if there is no session to renew, go to
 * sign-in and come back here afterwards.
 */
export function SessionRecovery() {
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
