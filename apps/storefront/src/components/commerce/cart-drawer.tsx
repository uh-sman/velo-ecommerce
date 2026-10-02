"use client";

import { formatMoney, type Schema } from "@velo/api-client";
import { ShoppingBagIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { announceCart, CART_CHANGED, OPEN_CART } from "@/components/commerce/cart-events";
import { QuantityStepper } from "@/components/commerce/quantity-stepper";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ui/sonner";
import { callApi, fieldErrors } from "@/lib/api-browser";
import { cn } from "@/lib/utils";

type Cart = Schema<"CartView">;

/*
 * DESIGN-SYSTEM.md §5 "Cart drawer": from the right, 400 px (full width on a
 * phone), focus trapped and returned on close, Escape closes. Lines with a
 * stepper and remove. Subtotal only — shipping and tax need an address, and
 * inventing a figure here breaks trust at checkout.
 */
export function CartDrawer({ initialCount }: { initialCount: number }) {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(initialCount);
  const [cart, setCart] = useState<Cart | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const pathname = usePathname();

  useEffect(() => {
    setCount(initialCount);
  }, [initialCount]);

  useEffect(() => {
    const changed = (event: Event) => {
      setCount((event as CustomEvent<number>).detail);
    };
    const openIt = () => {
      setOpen(true);
    };
    window.addEventListener(CART_CHANGED, changed);
    window.addEventListener(OPEN_CART, openIt);
    return () => {
      window.removeEventListener(CART_CHANGED, changed);
      window.removeEventListener(OPEN_CART, openIt);
    };
  }, []);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const load = useCallback(async () => {
    const outcome = await callApi((client) => client.GET("/api/v1/cart"));
    if (outcome.ok) {
      setCart(outcome.data);
      setCount(outcome.data.item_count);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function change(itemId: string, quantity: number, label: string) {
    setBusy(itemId);
    const outcome =
      quantity === 0
        ? await callApi((client) =>
            client.DELETE("/api/v1/cart/items/{item_id}", {
              params: { path: { item_id: itemId } },
            }),
          )
        : await callApi((client) =>
            client.PATCH("/api/v1/cart/items/{item_id}", {
              params: { path: { item_id: itemId } },
              body: { quantity },
            }),
          );
    setBusy(null);
    if (outcome.ok) {
      setCart(outcome.data);
      announceCart(outcome.data);
      if (quantity === 0) notify.success(`${label} removed`);
    } else {
      notify.error(Object.values(fieldErrors(outcome.problem))[0] ?? outcome.problem.title);
      await load();
    }
  }

  const trigger = (
    <SheetTrigger
      className="hover:bg-surface-sunken relative flex size-11 items-center justify-center rounded-md"
      aria-label={`Cart, ${String(count)} ${count === 1 ? "item" : "items"}`}
    >
      <ShoppingBagIcon className="size-5" aria-hidden />
      {count > 0 && (
        <span
          aria-hidden
          className="bg-primary text-primary-foreground absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums"
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
    </SheetTrigger>
  );

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      {trigger}
      <SheetContent side="right" className="w-full gap-0 sm:max-w-[400px]">
        <SheetHeader className="border-border-subtle border-b">
          <SheetTitle>Your cart{cart ? ` (${String(cart.item_count)})` : ""}</SheetTitle>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-4">
          {!cart ? (
            <div className="flex flex-col gap-3 py-4" aria-busy>
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </div>
          ) : cart.items.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <ShoppingBagIcon className="text-text-tertiary size-10" aria-hidden />
              <p className="font-medium">Your cart is empty</p>
              <Button asChild variant="outline">
                <Link href="/products">Shop new arrivals</Link>
              </Button>
            </div>
          ) : (
            <ul className="divide-border-subtle divide-y">
              {cart.items.map((item) => {
                const label = `${item.variant.product_title} ${item.variant.variant_title}`;
                return (
                  <li
                    key={item.id}
                    className={cn("flex gap-3 py-4", busy === item.id && "opacity-60")}
                  >
                    <div className="bg-surface-sunken relative size-20 shrink-0 overflow-hidden rounded-md">
                      {item.variant.image_url && (
                        <Image
                          src={item.variant.image_url}
                          alt=""
                          fill
                          sizes="80px"
                          className="object-cover"
                          unoptimized
                        />
                      )}
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <div className="flex justify-between gap-2">
                        <div className="min-w-0">
                          <Link
                            href={`/products/${item.variant.product_slug}`}
                            className="line-clamp-2 text-sm font-medium hover:underline"
                          >
                            {item.variant.product_title}
                          </Link>
                          <p className="text-text-secondary text-xs">
                            {item.variant.variant_title}
                          </p>
                        </div>
                        <p className="text-sm font-medium tabular-nums">
                          {formatMoney(item.line_total)}
                        </p>
                      </div>
                      {!item.purchasable && (
                        <p className="text-warning text-xs">No longer available</p>
                      )}
                      <div className="flex items-center gap-2">
                        {item.purchasable && (
                          <QuantityStepper
                            value={item.quantity}
                            max={Math.max(1, item.availability.max_quantity)}
                            disabled={busy === item.id}
                            label={label}
                            onChange={(quantity) => void change(item.id, quantity, label)}
                          />
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy === item.id}
                          onClick={() => void change(item.id, 0, item.variant.product_title)}
                          aria-label={`Remove ${label} from cart`}
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {cart && cart.items.length > 0 && (
          <SheetFooter className="border-border-subtle border-t">
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-text-secondary">Subtotal</span>
              <span className="text-base font-semibold tabular-nums">
                {formatMoney(cart.totals.subtotal)}
              </span>
            </div>
            <p className="text-text-secondary text-xs">
              Shipping and tax are calculated at checkout.
            </p>
            <Button asChild size="lg">
              <Link href="/checkout">Checkout</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/cart">View cart</Link>
            </Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}
