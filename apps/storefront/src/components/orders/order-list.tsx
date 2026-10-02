"use client";

import { formatMoney, type Schema } from "@velo/api-client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { announceCart, openCart } from "@/components/commerce/cart-events";
import { StatusBadge } from "@/components/orders/status";
import { FormAlert } from "@/components/forms/fields";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ui/sonner";
import { callApi } from "@/lib/api-browser";
import { formatDate } from "@/lib/utils";

type Summary = Schema<"OrderSummaryView">;

/*
 * PAGE-SPECS.md §2.3: newest first, 10 a page, one badge vocabulary with the
 * admin. "Buy again" adds every line that can still be bought and says
 * plainly what could not.
 */
export function OrderList() {
  const [orders, setOrders] = useState<Summary[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (after: string | null) => {
    setLoading(true);
    setFailed(false);
    const outcome = await callApi((client) =>
      client.GET("/api/v1/orders", {
        params: { query: { limit: 10, ...(after ? { cursor: after } : {}) } },
      }),
    );
    setLoading(false);
    if (!outcome.ok) {
      setFailed(true);
      return;
    }
    setOrders((current) => [...(after ? (current ?? []) : []), ...outcome.data.data]);
    setCursor(outcome.data.pagination.next_cursor ?? null);
  }, []);

  useEffect(() => {
    void load(null);
  }, [load]);

  if (failed && !orders) {
    return (
      <FormAlert title="We could not load your orders">
        <Button variant="link" className="h-auto p-0" onClick={() => void load(null)}>
          Try again
        </Button>
      </FormAlert>
    );
  }
  if (!orders) {
    return (
      <div className="flex flex-col gap-4" aria-busy>
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
    );
  }
  if (orders.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="font-medium">No orders yet</p>
        <Button asChild>
          <Link href="/products">Start shopping</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-4">
        {orders.map((order) => (
          <li
            key={order.number}
            className="border-border-subtle flex flex-col gap-3 rounded-lg border p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium">
                <span className="font-mono">{order.number}</span>
                <span className="text-text-secondary font-normal">
                  {" "}
                  · {formatDate(order.placed_at)}
                </span>
              </p>
              <StatusBadge status={order.status} />
            </div>
            <p className="text-text-secondary text-sm">
              {order.item_count} {order.item_count === 1 ? "item" : "items"} ·{" "}
              {formatMoney(order.total)}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm">
                <Link href={`/account/orders/${order.number}`}>View order</Link>
              </Button>
              <BuyAgain number={order.number} />
            </div>
          </li>
        ))}
      </ul>
      {cursor && (
        <Button
          variant="outline"
          className="self-center"
          loading={loading}
          onClick={() => void load(cursor)}
        >
          Older orders
        </Button>
      )}
    </div>
  );
}

function BuyAgain({ number }: { number: string }) {
  const [pending, setPending] = useState(false);

  async function run() {
    setPending(true);
    const detail = await callApi((client) =>
      client.GET("/api/v1/orders/{number}", { params: { path: { number } } }),
    );
    if (!detail.ok) {
      setPending(false);
      notify.error("We could not read that order. Please try again.");
      return;
    }
    const missed: string[] = [];
    let last: Schema<"CartView"> | null = null;
    for (const line of detail.data.lines) {
      if (!line.variant_id) {
        missed.push(line.product_title);
        continue;
      }
      const variantId = line.variant_id;
      const added = await callApi((client) =>
        client.POST("/api/v1/cart/items", {
          body: { variant_id: variantId, quantity: line.quantity },
        }),
      );
      if (added.ok) last = added.data;
      else missed.push(line.product_title);
    }
    setPending(false);
    if (last) {
      announceCart(last);
      openCart();
    }
    if (missed.length === 0) notify.success("Everything is back in your cart.");
    else if (last)
      notify.warning(`Added to your cart — except ${missed.join(", ")}, no longer available.`);
    else notify.error("None of these items can be bought any more.");
  }

  return (
    <Button variant="ghost" size="sm" loading={pending} onClick={() => void run()}>
      Buy again
    </Button>
  );
}
