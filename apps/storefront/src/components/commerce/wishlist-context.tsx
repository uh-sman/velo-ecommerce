"use client";

import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { notify } from "@/components/ui/sonner";
import { callApi } from "@/lib/api-browser";

interface Wishlist {
  has: (productId: string) => boolean;
  toggle: (productId: string, title: string) => Promise<void>;
}

const WishlistContext = createContext<Wishlist>({
  has: () => false,
  toggle: async () => {},
});

export function useWishlist(): Wishlist {
  return useContext(WishlistContext);
}

/*
 * The saved-product ids, loaded once per visit for a signed-in customer, so
 * every heart on the page shows its state without a request each. Toggling
 * is optimistic and rolls back if the server refuses. A guest who taps a
 * heart is sent to sign in, and back.
 */
export function WishlistProvider({
  signedIn,
  children,
}: {
  signedIn: boolean;
  children: React.ReactNode;
}) {
  const [ids, setIds] = useState<Set<string>>(new Set());
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!signedIn) {
      setIds(new Set());
      return;
    }
    void callApi((client) => client.GET("/api/v1/account/wishlist"), {
      refreshOnExpiry: true,
    }).then((outcome) => {
      if (outcome.ok) setIds(new Set(outcome.data.map((card) => card.id)));
    });
  }, [signedIn]);

  const toggle = useCallback(
    async (productId: string, title: string) => {
      if (!signedIn) {
        router.push(`/sign-in?next=${encodeURIComponent(pathname)}`);
        return;
      }
      const saving = !ids.has(productId);
      setIds((current) => {
        const next = new Set(current);
        if (saving) next.add(productId);
        else next.delete(productId);
        return next;
      });
      const outcome = saving
        ? await callApi((client) =>
            client.POST("/api/v1/account/wishlist", { body: { product_id: productId } }),
          )
        : await callApi((client) =>
            client.DELETE("/api/v1/account/wishlist/{product_id}", {
              params: { path: { product_id: productId } },
            }),
          );
      if (outcome.ok) {
        notify.success(saving ? `Saved ${title}` : `Removed ${title}`);
        return;
      }
      setIds((current) => {
        const next = new Set(current);
        if (saving) next.delete(productId);
        else next.add(productId);
        return next;
      });
      notify.error("We could not update your wishlist. Please try again.");
    },
    [ids, pathname, router, signedIn],
  );

  const value = useMemo(() => ({ has: (id: string) => ids.has(id), toggle }), [ids, toggle]);
  return <WishlistContext.Provider value={value}>{children}</WishlistContext.Provider>;
}
