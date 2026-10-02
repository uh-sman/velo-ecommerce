"use client";

import { formatMoney, type Schema } from "@velo/api-client";
import { ShoppingBagIcon, TriangleAlertIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { announceCart } from "@/components/commerce/cart-events";
import { OrderSummary } from "@/components/commerce/order-summary";
import { QuantityStepper } from "@/components/commerce/quantity-stepper";
import { FormAlert, TextField } from "@/components/forms/fields";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ui/sonner";
import { callApi, fieldErrors, type Outcome } from "@/lib/api-browser";
import { cn } from "@/lib/utils";

type Cart = Schema<"CartView">;
type Item = Schema<"CartItemView">;

/*
 * PAGE-SPECS.md §1.3. The server's cart is the only source of numbers: every
 * mutation returns the re-priced cart, which replaces local state. Warnings
 * (price changed, stock dropped) are shown on the line they concern.
 */
export function CartPage() {
  const [cart, setCart] = useState<Cart | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyLine, setBusyLine] = useState<string | null>(null);
  const [lineError, setLineError] = useState<Record<string, string>>({});
  const [announcement, setAnnouncement] = useState("");

  const load = useCallback(async () => {
    setLoadFailed(false);
    const outcome = await callApi((client) => client.GET("/api/v1/cart"));
    if (outcome.ok) setCart(outcome.data);
    else setLoadFailed(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function apply(outcome: Outcome<Cart>, itemId: string | null, message: string) {
    if (outcome.ok) {
      setCart(outcome.data);
      announceCart(outcome.data);
      setAnnouncement(`${message} Cart total ${formatMoney(outcome.data.totals.total)}.`);
      if (itemId) setLineError(({ [itemId]: _dropped, ...rest }) => rest);
      return true;
    }
    const detail =
      Object.values(fieldErrors(outcome.problem))[0] ??
      outcome.problem.detail ??
      outcome.problem.title;
    if (itemId) setLineError((errors) => ({ ...errors, [itemId]: detail }));
    else notify.error(detail);
    return false;
  }

  async function setQuantity(item: Item, quantity: number) {
    setBusyLine(item.id);
    const outcome = await callApi((client) =>
      client.PATCH("/api/v1/cart/items/{item_id}", {
        params: { path: { item_id: item.id } },
        body: { quantity },
      }),
    );
    apply(outcome, item.id, "Quantity updated.");
    // A rejected change leaves the stepper on the server's value: refetch.
    if (!outcome.ok) await load();
    setBusyLine(null);
  }

  async function remove(item: Item) {
    setBusyLine(item.id);
    const outcome = await callApi((client) =>
      client.DELETE("/api/v1/cart/items/{item_id}", {
        params: { path: { item_id: item.id } },
      }),
    );
    setBusyLine(null);
    if (!apply(outcome, item.id, `${item.variant.product_title} removed.`)) return;
    // Undo for five seconds instead of a confirmation dialog (DESIGN-SYSTEM.md §4).
    notify.success(`${item.variant.product_title} removed`, {
      action: {
        label: "Undo",
        onClick: () => {
          void callApi((client) =>
            client.POST("/api/v1/cart/items", {
              body: { variant_id: item.variant.id, quantity: item.quantity },
            }),
          ).then((undone) => apply(undone, null, "Item restored."));
        },
      },
    });
  }

  async function removeCode() {
    const outcome = await callApi((client) => client.DELETE("/api/v1/cart/discount"));
    apply(outcome, null, "Discount removed.");
  }

  if (loadFailed) {
    return (
      <FormAlert title="We could not load your cart">
        <Button variant="link" className="h-auto p-0" onClick={() => void load()}>
          Try again
        </Button>
      </FormAlert>
    );
  }
  if (!cart) {
    return (
      <div className="grid gap-8 lg:grid-cols-[1fr_22rem]" aria-busy>
        <div className="flex flex-col gap-4">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
        <Skeleton className="h-72" />
      </div>
    );
  }
  if (cart.items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 py-16 text-center">
        <ShoppingBagIcon className="text-text-tertiary size-12" aria-hidden />
        <h1 className="text-2xl font-semibold tracking-tight">Your cart is empty</h1>
        <div className="flex flex-wrap justify-center gap-3">
          <Button asChild>
            <Link href="/products">Shop new arrivals</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/collections">View collections</Link>
          </Button>
        </div>
      </div>
    );
  }

  const available = cart.items.filter((item) => item.purchasable);
  const unavailable = cart.items.filter((item) => !item.purchasable);
  const cartWarnings = cart.warnings.filter((warning) => !warning.item_id);
  const warningsFor = (id: string) => cart.warnings.filter((warning) => warning.item_id === id);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">
        Your cart ({cart.item_count} {cart.item_count === 1 ? "item" : "items"})
      </h1>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      {cartWarnings.map((warning) => (
        <FormAlert key={warning.code + warning.message} tone="info" title={warning.message} />
      ))}

      <div className="grid gap-8 lg:grid-cols-[1fr_22rem] lg:items-start">
        <div className="flex flex-col gap-6">
          <ul className="divide-border-subtle border-border-subtle divide-y border-y">
            {available.map((item) => (
              <CartLine
                key={item.id}
                item={item}
                busy={busyLine === item.id}
                error={lineError[item.id]}
                warnings={warningsFor(item.id)}
                onQuantity={(quantity) => void setQuantity(item, quantity)}
                onRemove={() => void remove(item)}
              />
            ))}
          </ul>

          {unavailable.length > 0 && (
            <section aria-labelledby="unavailable-heading" className="flex flex-col gap-2">
              <h2 id="unavailable-heading" className="font-semibold">
                No longer available
              </h2>
              <ul className="divide-border-subtle divide-y opacity-70">
                {unavailable.map((item) => (
                  <CartLine
                    key={item.id}
                    item={item}
                    busy={busyLine === item.id}
                    error={lineError[item.id]}
                    warnings={warningsFor(item.id)}
                    onRemove={() => void remove(item)}
                  />
                ))}
              </ul>
            </section>
          )}

          <DiscountForm
            applied={cart.discount_code}
            onApplied={(next) => {
              apply({ ok: true, data: next }, null, "Discount applied.");
            }}
          />
          <Link href="/products" className="text-sm underline underline-offset-4">
            ← Continue shopping
          </Link>
        </div>

        <OrderSummary
          className="lg:sticky lg:top-6"
          totals={cart.totals}
          itemCount={cart.item_count}
          discounts={cart.discounts}
          onRemoveCode={() => void removeCode()}
        >
          <Button asChild size="lg" className={cn(available.length === 0 && "hidden")}>
            <Link href="/checkout">Checkout</Link>
          </Button>
          <p className="text-text-secondary text-xs">
            Secure payment. Card details go straight to our payment provider and never touch our
            servers.
          </p>
        </OrderSummary>
      </div>

      {/* Mobile: the total and Checkout stay in reach (PAGE-SPECS.md §1.3 "Mobile"). */}
      <div className="bg-surface-page border-border-subtle sticky bottom-0 -mx-4 flex items-center justify-between gap-4 border-t px-4 py-3 lg:hidden">
        <p className="font-semibold tabular-nums">Total {formatMoney(cart.totals.total)}</p>
        {available.length > 0 && (
          <Button asChild>
            <Link href="/checkout">Checkout</Link>
          </Button>
        )}
      </div>
    </div>
  );
}

function CartLine({
  item,
  busy,
  error,
  warnings,
  onQuantity,
  onRemove,
}: {
  item: Item;
  busy: boolean;
  error: string | undefined;
  warnings: Schema<"CartWarning">[];
  onQuantity?: (quantity: number) => void;
  onRemove: () => void;
}) {
  const name = `${item.variant.product_title} ${item.variant.variant_title}`;
  return (
    <li className={cn("flex gap-4 py-4 transition-opacity", busy && "opacity-60")}>
      <div className="bg-surface-sunken relative size-24 shrink-0 overflow-hidden rounded-md">
        {item.variant.image_url && (
          <Image
            src={item.variant.image_url}
            alt=""
            fill
            sizes="96px"
            className="object-cover"
            unoptimized
          />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Link
              href={`/products/${item.variant.product_slug}`}
              className="font-medium hover:underline"
            >
              {item.variant.product_title}
            </Link>
            <p className="text-text-secondary text-sm">{item.variant.variant_title}</p>
          </div>
          <div className="text-right text-sm tabular-nums">
            <p className="font-medium">{formatMoney(item.line_total)}</p>
            {item.quantity > 1 && (
              <p className="text-text-secondary">{formatMoney(item.unit_price)} each</p>
            )}
            {item.line_discount.amount > 0 && (
              <p className="text-success">−{formatMoney(item.line_discount)}</p>
            )}
          </div>
        </div>
        {warnings.map((warning) => (
          <p key={warning.code} className="text-warning flex items-start gap-1.5 text-sm">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
            {warning.message}
          </p>
        ))}
        {error && (
          <p role="alert" className="text-danger text-sm">
            {error}
          </p>
        )}
        <div className="flex items-center gap-3">
          {onQuantity && (
            <QuantityStepper
              value={item.quantity}
              max={Math.max(1, item.availability.max_quantity)}
              disabled={busy}
              label={name}
              onChange={onQuantity}
            />
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={onRemove}
            disabled={busy}
            aria-label={`Remove ${name} from cart`}
          >
            Remove
          </Button>
        </div>
      </div>
    </li>
  );
}

function DiscountForm({
  applied,
  onApplied,
}: {
  applied: string | null;
  onApplied: (cart: Cart) => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!code.trim()) {
      setError("Enter a discount code.");
      input.current?.focus();
      return;
    }
    setPending(true);
    const outcome = await callApi((client) =>
      client.POST("/api/v1/cart/discount", { body: { code: code.trim() } }),
    );
    setPending(false);
    if (outcome.ok) {
      setError(undefined);
      setCode("");
      onApplied(outcome.data);
      notify.success("Discount applied");
    } else {
      setError(outcome.problem.errors?.[0]?.message ?? outcome.problem.detail);
      input.current?.focus();
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="flex items-end gap-2" noValidate>
      <TextField
        ref={input}
        label={applied ? `Discount code (${applied} entered)` : "Discount code"}
        className="max-w-72 flex-1"
        value={code}
        autoComplete="off"
        autoCapitalize="characters"
        error={error}
        onChange={(event) => {
          setCode(event.target.value);
        }}
      />
      <Button type="submit" variant="outline" loading={pending} className="mb-auto mt-7">
        Apply
      </Button>
    </form>
  );
}
