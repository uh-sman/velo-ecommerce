"use client";

import type { Schema } from "@velo/api-client";
import { CheckIcon, HeartIcon, RotateCcwIcon, TruckIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { announceCart, openCart } from "@/components/commerce/cart-events";
import { PriceDisplay, RatingStars } from "@/components/commerce/price";
import { QuantityStepper } from "@/components/commerce/quantity-stepper";
import { useWishlist } from "@/components/commerce/wishlist-context";
import { Gallery } from "@/components/product/gallery";
import { FormAlert, TextField } from "@/components/forms/fields";
import { Button } from "@/components/ui/button";
import { callApi, fieldErrors } from "@/lib/api-browser";
import { cn } from "@/lib/utils";

type Product = Schema<"ProductDetail">;
type Variant = Schema<"VariantView">;

function matches(variant: Variant, selection: Record<string, string>): boolean {
  return Object.entries(selection).every(([name, value]) => variant.option_values[name] === value);
}

function initialSelection(product: Product): Record<string, string> {
  const first =
    product.variants.find((variant) => variant.availability.in_stock) ?? product.variants[0];
  return { ...(first?.option_values ?? {}) };
}

/*
 * The product page's gallery and buy box (DESIGN-SYSTEM.md §5 "Product
 * detail"). The variant selector reflects real availability — an option no
 * in-stock variant has is struck through and says so. Add to cart is
 * optimistic: the button confirms at once and the drawer opens; a refusal
 * rolls it back with the reason. On phones a sticky bar keeps price and Add
 * to cart in reach once the inline button scrolls away.
 */
export function ProductBuy({ product }: { product: Product }) {
  const [selection, setSelection] = useState(() => initialSelection(product));
  const [quantity, setQuantity] = useState(1);
  const [state, setState] = useState<"idle" | "adding" | "added">("idle");
  const [error, setError] = useState<string | null>(null);
  const [inlineVisible, setInlineVisible] = useState(true);
  const inline = useRef<HTMLDivElement>(null);
  const wishlist = useWishlist();

  const variant = useMemo(
    () => product.variants.find((candidate) => matches(candidate, selection)) ?? null,
    [product.variants, selection],
  );
  const available = variant?.availability.in_stock ?? false;
  const left = variant?.availability.quantity_available ?? null;
  const variantMedia = product.media.find((m) => m.variant_id && m.variant_id === variant?.id);

  useEffect(() => {
    const node = inline.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      setInlineVisible(entry?.isIntersecting ?? true);
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);

  function selectable(name: string, value: string): boolean {
    const next = { ...selection, [name]: value };
    return product.variants.some(
      (candidate) => matches(candidate, next) && candidate.availability.in_stock,
    );
  }

  async function add() {
    if (!variant) return;
    setError(null);
    setState("added"); // optimistic
    const outcome = await callApi((client) =>
      client.POST("/api/v1/cart/items", { body: { variant_id: variant.id, quantity } }),
    );
    if (outcome.ok) {
      announceCart(outcome.data);
      openCart();
      setTimeout(() => {
        setState("idle");
      }, 2000);
    } else {
      setState("idle"); // roll back
      setError(
        Object.values(fieldErrors(outcome.problem))[0] ??
          outcome.problem.detail ??
          outcome.problem.title,
      );
    }
  }

  const addButton = (size: "lg" | "xl") => (
    <Button
      size={size}
      onClick={() => void add()}
      disabled={!available || state !== "idle"}
      className="flex-1"
    >
      {state === "added" ? (
        <>
          <CheckIcon aria-hidden /> Added
        </>
      ) : available ? (
        "Add to cart"
      ) : (
        "Out of stock"
      )}
    </Button>
  );

  return (
    <div className="grid gap-8 lg:grid-cols-2 lg:gap-12">
      <Gallery media={product.media} title={product.title} focusMediaId={variantMedia?.id} />

      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          {product.brand && <p className="text-text-secondary text-sm">{product.brand}</p>}
          <h1 className="text-3xl font-semibold tracking-tight">{product.title}</h1>
          {product.subtitle && <p className="text-text-secondary">{product.subtitle}</p>}
          {product.rating && product.rating.count > 0 && (
            <a href="#reviews" className="self-start hover:underline">
              <RatingStars average={product.rating.average} count={product.rating.count} />
            </a>
          )}
        </div>

        {variant && <PriceDisplay price={variant.price} compareAt={variant.compare_at} size="lg" />}

        {product.options.map((option) => (
          <fieldset key={option.name} className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">
              {option.name}: <span className="font-normal">{selection[option.name]}</span>
            </legend>
            <div className="flex flex-wrap gap-2">
              {option.values.map(({ value, swatch_hex }) => {
                const active = selection[option.name] === value;
                const ok = selectable(option.name, value);
                return (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={active}
                    aria-disabled={!ok}
                    aria-label={ok ? value : `${value} — out of stock`}
                    title={ok ? value : `${value} — out of stock`}
                    onClick={() => {
                      if (ok) setSelection({ ...selection, [option.name]: value });
                    }}
                    className={cn(
                      "border-border-default relative flex h-11 min-w-11 items-center justify-center rounded-md border px-3 text-sm",
                      swatch_hex && "w-11 rounded-full p-0",
                      active && "border-primary ring-primary/40 ring-2 ring-offset-2",
                      !ok && "cursor-not-allowed opacity-50",
                      !ok && !swatch_hex && "text-text-tertiary line-through",
                    )}
                  >
                    {swatch_hex ? (
                      <span
                        aria-hidden
                        className="size-8 rounded-full border"
                        style={{ backgroundColor: swatch_hex }}
                      />
                    ) : (
                      value
                    )}
                    {swatch_hex && !ok && (
                      <span
                        aria-hidden
                        className="bg-text-secondary absolute h-px w-12 rotate-45"
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </fieldset>
        ))}

        <p className="text-sm font-medium" aria-live="polite">
          {!variant ? (
            <span className="text-text-secondary">That combination is not made.</span>
          ) : !available ? (
            <span className="text-danger">Out of stock</span>
          ) : left !== null && left <= 5 ? (
            <span className="text-warning">Only {left} left</span>
          ) : (
            <span className="text-success">In stock</span>
          )}
        </p>

        <div ref={inline} className="flex flex-wrap items-center gap-3">
          <QuantityStepper
            value={quantity}
            max={Math.max(1, left ?? 99)}
            label={product.title}
            onChange={setQuantity}
            disabled={!available}
          />
          {addButton("lg")}
          <Button
            variant="outline"
            size="lg"
            onClick={() => void wishlist.toggle(product.id, product.title)}
            aria-pressed={wishlist.has(product.id)}
            aria-label={wishlist.has(product.id) ? "Remove from wishlist" : "Save to wishlist"}
          >
            <HeartIcon
              className={cn(wishlist.has(product.id) && "fill-sale text-sale")}
              aria-hidden
            />
          </Button>
        </div>
        {error && <FormAlert title="Not added to your cart">{error}</FormAlert>}
        {variant && !available && <BackInStock slug={product.slug} variantId={variant.id} />}

        <ul className="text-text-secondary flex flex-col gap-2 text-sm">
          <li className="flex items-center gap-2">
            <TruckIcon className="size-4" aria-hidden /> Free shipping over $75
          </li>
          <li className="flex items-center gap-2">
            <RotateCcwIcon className="size-4" aria-hidden /> 30-day returns
          </li>
        </ul>
      </div>

      {/* Mobile: the buy action never needs a scroll back up. */}
      {!inlineVisible && variant && (
        <div className="bg-surface-page border-border-subtle fixed inset-x-0 bottom-0 z-30 flex items-center gap-3 border-t px-4 py-3 lg:hidden">
          <PriceDisplay price={variant.price} size="md" className="shrink-0" />
          {addButton("lg")}
        </div>
      )}
    </div>
  );
}

function BackInStock({ slug, variantId }: { slug: string; variantId: string }) {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setDone(false);
  }, [variantId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    const outcome = await callApi((client) =>
      client.POST("/api/v1/products/{slug}/back-in-stock", {
        params: { path: { slug } },
        body: { variant_id: variantId, email: email || null },
      }),
    );
    setPending(false);
    if (outcome.ok) setDone(true);
    else setError(fieldErrors(outcome.problem)["email"] ?? outcome.problem.title);
  }

  if (done) {
    return (
      <FormAlert tone="success" title="We will email you when it is back">
        One email, and only for this.
      </FormAlert>
    );
  }
  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="border-border-subtle flex flex-col gap-3 rounded-lg border p-4"
      noValidate
    >
      <p className="text-sm font-medium">Email me when it is back in stock</p>
      <div className="flex items-end gap-2">
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          className="flex-1"
          value={email}
          error={error}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
        />
        <Button type="submit" variant="outline" loading={pending} className="mb-auto mt-7">
          Notify me
        </Button>
      </div>
    </form>
  );
}
