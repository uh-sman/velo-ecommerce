"use client";

import { formatMoney, type Schema } from "@velo/api-client";
import { PlusIcon, SearchIcon, XIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { FieldError, TextField } from "@/components/forms/fields";
import { MoneyText } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { callApi, fieldErrors } from "@/lib/api-browser";

import { CART_PROBLEMS, draftToFields, type Draft, type Target } from "./discount-rules";
import { SelectField, problemMessage, useDebounced, useResource } from "./shared";

type ProductRow = Schema<"AdminProductRow">;
type Collection = Schema<"AdminCollectionView">;
type Preview = Schema<"PreviewView">;

/** Products matching a search, for both the target picker and the test basket. */
function useProductSearch(query: string) {
  const q = useDebounced(query.trim());
  const [results, setResults] = useState<ProductRow[]>([]);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!q) {
      setResults([]);
      setState("idle");
      return;
    }
    let live = true;
    setState("loading");
    void callApi((client) =>
      client.GET("/api/v1/admin/products", { params: { query: { q, limit: 8 } } }),
    ).then((outcome) => {
      if (!live) return;
      if (outcome.ok) {
        setResults(outcome.data.data);
        setState("ready");
      } else {
        setError(problemMessage(outcome.problem));
        setState("error");
      }
    });
    return () => {
      live = false;
    };
  }, [q]);
  return { q, results, state, error };
}

function SearchBox({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="relative">
        <SearchIcon
          className="text-text-tertiary pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2"
          aria-hidden
        />
        <Input
          id={id}
          type="search"
          className="pl-9"
          placeholder={placeholder}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      </div>
    </div>
  );
}

/** The chosen products or collections, as removable chips, plus a way to add more. */
export function TargetPicker({
  kind,
  targets,
  onChange,
  error,
  disabled,
}: {
  kind: "products" | "collections";
  targets: Target[];
  onChange: (targets: Target[]) => void;
  error?: string | undefined;
  disabled?: boolean;
}) {
  const errorId = useId();
  const chosen = new Set(targets.map((target) => target.id));
  function add(target: Target) {
    if (!chosen.has(target.id)) onChange([...targets, target]);
  }
  return (
    <div className="flex flex-col gap-3" aria-describedby={error ? errorId : undefined}>
      {targets.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label={`Chosen ${kind}`}>
          {targets.map((target) => (
            <li
              key={target.id}
              className="bg-surface-sunken flex items-center gap-1 rounded-md py-1 pl-3 pr-1 text-sm"
            >
              {target.label}
              <button
                type="button"
                disabled={disabled}
                aria-label={`Remove ${target.label}`}
                className="hover:bg-accent focus-visible:ring-ring/50 relative flex size-7 items-center justify-center rounded-sm outline-none after:absolute after:-inset-2 focus-visible:ring-[3px] disabled:opacity-50"
                onClick={() => {
                  onChange(targets.filter((item) => item.id !== target.id));
                }}
              >
                <XIcon className="size-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-text-secondary text-sm">
          No {kind} chosen yet — the discount applies to nothing until you add some.
        </p>
      )}
      <FieldError id={errorId} message={error} />
      {!disabled &&
        (kind === "products" ? (
          <ProductAdder chosen={chosen} onAdd={add} />
        ) : (
          <CollectionAdder chosen={chosen} onAdd={add} />
        ))}
    </div>
  );
}

function ProductAdder({ chosen, onAdd }: { chosen: Set<string>; onAdd: (target: Target) => void }) {
  const [query, setQuery] = useState("");
  const search = useProductSearch(query);
  return (
    <div className="flex flex-col gap-2">
      <SearchBox
        label="Add products"
        placeholder="Search products by name or SKU"
        value={query}
        onChange={setQuery}
      />
      <SearchResults
        state={search.state}
        error={search.error}
        empty={`No products match “${search.q}”.`}
        items={search.results.map((product) => ({
          id: product.id,
          label: product.title,
          meta: product.status !== "active" ? product.status : null,
        }))}
        chosen={chosen}
        onAdd={onAdd}
      />
    </div>
  );
}

function CollectionAdder({
  chosen,
  onAdd,
}: {
  chosen: Set<string>;
  onAdd: (target: Target) => void;
}) {
  const [query, setQuery] = useState("");
  const { load, reload } = useResource(
    () => callApi((client) => client.GET("/api/v1/admin/collections")),
    "collections",
  );
  if (load.state === "loading") return <Skeleton className="h-24 w-full" />;
  if (load.state === "error") {
    return (
      <p className="text-danger text-sm">
        {load.message}{" "}
        <button type="button" className="min-h-11 underline" onClick={reload}>
          Try again
        </button>
      </p>
    );
  }
  const needle = query.trim().toLowerCase();
  const matches: Collection[] = load.data.filter(
    (collection) => !needle || collection.title.toLowerCase().includes(needle),
  );
  return (
    <div className="flex flex-col gap-2">
      <SearchBox
        label="Add collections"
        placeholder="Filter collections"
        value={query}
        onChange={setQuery}
      />
      <SearchResults
        state="ready"
        error={null}
        empty={load.data.length === 0 ? "There are no collections yet." : "No collections match."}
        items={matches.slice(0, 12).map((collection) => ({
          id: collection.id,
          label: collection.title,
          meta: `${String(collection.products.length)} products${collection.is_active ? "" : " · hidden"}`,
        }))}
        chosen={chosen}
        onAdd={onAdd}
      />
    </div>
  );
}

function SearchResults({
  state,
  error,
  empty,
  items,
  chosen,
  onAdd,
}: {
  state: "idle" | "loading" | "ready" | "error";
  error: string | null;
  empty: string;
  items: { id: string; label: string; meta: string | null }[];
  chosen: Set<string>;
  onAdd: (target: Target) => void;
}) {
  if (state === "idle") return null;
  if (state === "loading") return <Skeleton className="h-24 w-full" />;
  if (state === "error") return <p className="text-danger text-sm">{error}</p>;
  if (items.length === 0) return <p className="text-text-secondary text-sm">{empty}</p>;
  return (
    <ul className="border-border-subtle divide-border-subtle divide-y rounded-md border">
      {items.map((item) => {
        const added = chosen.has(item.id);
        return (
          <li key={item.id} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
            <span className="min-w-0">
              <span className="block truncate">{item.label}</span>
              {item.meta && <span className="text-text-secondary text-xs">{item.meta}</span>}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={added}
              aria-label={added ? `${item.label} added` : `Add ${item.label}`}
              onClick={() => {
                onAdd({ id: item.id, label: item.label });
              }}
            >
              {added ? "Added" : "Add"}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

// ── Eligibility tester ───────────────────────────────────────────────────────

interface BasketLine {
  variantId: string;
  label: string;
  quantity: number;
}

function lineText(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  return typeof value === "string" ? value : "";
}

function lineNumber(raw: Record<string, unknown>, key: string): number {
  const value = raw[key];
  return typeof value === "number" ? value : 0;
}

/**
 * Price a sample basket with the rule as it stands in the form — through the
 * same engine checkout uses — and say whether it applies, and why not.
 */
export function EligibilityTester({ draft }: { draft: Draft }) {
  const [lines, setLines] = useState<BasketLine[]>([]);
  const [email, setEmail] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<Preview | null>(null);
  const [problem, setProblem] = useState<{ title: string; fields: string[] } | null>(null);
  const [emailError, setEmailError] = useState<string | undefined>(undefined);

  async function test() {
    setTesting(true);
    setProblem(null);
    setEmailError(undefined);
    const outcome = await callApi((client) =>
      client.POST("/api/v1/admin/discounts/preview", {
        body: {
          discount: draftToFields(draft),
          lines: lines.map((line) => ({ variant_id: line.variantId, quantity: line.quantity })),
          customer_email: email.trim() || null,
        },
      }),
    );
    setTesting(false);
    if (outcome.ok) {
      setResult(outcome.data);
      return;
    }
    setResult(null);
    const errors = fieldErrors(outcome.problem);
    if (errors["customer_email"]) setEmailError(errors["customer_email"]);
    const ruleErrors = Object.entries(errors)
      .filter(([field]) => field !== "customer_email" && !field.startsWith("lines"))
      .map(
        ([field, message]) => `${field.replace(/^discount\.?/, "").replace(/_/g, " ")}: ${message}`,
      );
    setProblem({
      title:
        ruleErrors.length > 0
          ? "Fix the rule above before testing it."
          : problemMessage(outcome.problem),
      fields: ruleErrors,
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-text-secondary text-sm">
        Build a sample basket and see exactly what checkout would do with this rule as it stands in
        the form — saved or not.
      </p>
      <BasketBuilder
        onAdd={(line) => {
          setResult(null);
          setLines((current) => {
            const existing = current.find((item) => item.variantId === line.variantId);
            return existing
              ? current.map((item) =>
                  item.variantId === line.variantId
                    ? { ...item, quantity: Math.min(999, item.quantity + line.quantity) }
                    : item,
                )
              : [...current, line];
          });
        }}
      />
      {lines.length > 0 && (
        <ul
          className="border-border-subtle divide-border-subtle divide-y rounded-md border"
          aria-label="Test basket"
        >
          {lines.map((line) => (
            <li key={line.variantId} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{line.label}</span>
              <label className="sr-only" htmlFor={`qty-${line.variantId}`}>
                Quantity of {line.label}
              </label>
              <Input
                id={`qty-${line.variantId}`}
                type="number"
                min={1}
                max={999}
                inputMode="numeric"
                className="w-20"
                value={String(line.quantity)}
                onChange={(event) => {
                  const quantity = Math.max(1, Math.min(999, Number(event.target.value) || 1));
                  setResult(null);
                  setLines((current) =>
                    current.map((item) =>
                      item.variantId === line.variantId ? { ...item, quantity } : item,
                    ),
                  );
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Remove ${line.label} from the test basket`}
                onClick={() => {
                  setResult(null);
                  setLines((current) =>
                    current.filter((item) => item.variantId !== line.variantId),
                  );
                }}
              >
                <XIcon aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <TextField
        label="Customer email"
        optional
        type="email"
        hint="Checks first-order, segment and per-customer rules for this person. Empty: a new guest."
        value={email}
        error={emailError}
        onChange={(event) => {
          setEmail(event.target.value);
          setResult(null);
        }}
      />
      <div>
        <Button
          type="button"
          variant="secondary"
          loading={testing}
          disabled={lines.length === 0}
          onClick={() => {
            void test();
          }}
        >
          Test this basket
        </Button>
        {lines.length === 0 && (
          <p className="text-text-secondary mt-1 text-sm">Add at least one product to test.</p>
        )}
      </div>
      <div aria-live="polite">
        {problem && (
          <div role="alert" className="border-danger/40 bg-danger/10 rounded-md border p-3 text-sm">
            <p className="font-medium">{problem.title}</p>
            {problem.fields.length > 0 && (
              <ul className="text-text-secondary mt-1 list-disc pl-5">
                {problem.fields.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {result && <PreviewResult result={result} />}
      </div>
    </div>
  );
}

function PreviewResult({ result }: { result: Preview }) {
  const money = (amount: number) => ({ amount, currency: result.currency });
  const reason =
    result.customer_problem ??
    (result.cart_problem
      ? (CART_PROBLEMS[result.cart_problem] ??
        `The basket does not qualify (${result.cart_problem}).`)
      : "It does not apply to this basket.");
  return (
    <div
      className={
        result.eligible
          ? "border-success/40 bg-success/10 rounded-md border p-3 text-sm"
          : "border-warning/40 bg-warning/10 rounded-md border p-3 text-sm"
      }
    >
      <p className="font-medium">
        {result.eligible ? "Eligible — this basket gets the discount." : "Not eligible."}
      </p>
      {!result.eligible && <p className="mt-1">{reason}</p>}
      {result.shipping_discounted && (
        <p className="mt-1">Shipping will be free at checkout; the saving shows there.</p>
      )}
      <dl className="mt-3 grid max-w-xs grid-cols-2 gap-y-1">
        <dt className="text-text-secondary">Subtotal</dt>
        <dd className="text-right">
          <MoneyText money={money(result.subtotal)} />
        </dd>
        <dt className="text-text-secondary">Discount</dt>
        <dd className="text-right">
          {result.discount > 0 ? "−" : ""}
          <MoneyText money={money(result.discount)} />
        </dd>
        <dt className="font-medium">Total before shipping and tax</dt>
        <dd className="text-right font-medium">
          <MoneyText money={money(result.total)} />
        </dd>
      </dl>
      {result.lines.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1">
          {result.lines.map((raw, index) => {
            const discount = lineNumber(raw, "discount");
            return (
              <li
                key={lineText(raw, "variant_id") || String(index)}
                className="flex justify-between gap-3"
              >
                <span className="min-w-0 truncate">
                  {String(lineNumber(raw, "quantity"))} × {lineText(raw, "title")}
                </span>
                <span className="shrink-0 tabular-nums">
                  {formatMoney(money(lineNumber(raw, "subtotal")))}
                  {discount > 0 && (
                    <span className="text-success"> −{formatMoney(money(discount))}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Search a product, pick one of its variants and a quantity, add it to the basket. */
function BasketBuilder({ onAdd }: { onAdd: (line: BasketLine) => void }) {
  const [query, setQuery] = useState("");
  const search = useProductSearch(query);
  const [product, setProduct] = useState<Schema<"AdminProductView"> | null>(null);
  const [loadingProduct, setLoadingProduct] = useState(false);
  const [productError, setProductError] = useState<string | null>(null);
  const [variantId, setVariantId] = useState("");
  const [quantity, setQuantity] = useState("1");

  async function choose(id: string) {
    setLoadingProduct(true);
    setProductError(null);
    const outcome = await callApi((client) =>
      client.GET("/api/v1/admin/products/{product_id}", { params: { path: { product_id: id } } }),
    );
    setLoadingProduct(false);
    if (!outcome.ok) {
      setProductError(problemMessage(outcome.problem));
      return;
    }
    setProduct(outcome.data);
    setVariantId(outcome.data.variants[0]?.id ?? "");
    setQuantity("1");
  }

  if (product) {
    const variant = product.variants.find((item) => item.id === variantId);
    return (
      <div className="border-border-subtle flex flex-col gap-3 rounded-md border p-3">
        <p className="text-sm font-medium">{product.title}</p>
        {product.variants.length === 0 ? (
          <p className="text-text-secondary text-sm">This product has no variants to add.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-[1fr_6rem]">
            <SelectField
              label="Variant"
              value={variantId}
              onChange={(event) => {
                setVariantId(event.target.value);
              }}
            >
              {product.variants.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title} · {item.sku} · {formatMoney(item.price)}
                </option>
              ))}
            </SelectField>
            <TextField
              label="Quantity"
              type="number"
              inputMode="numeric"
              min={1}
              max={999}
              value={quantity}
              onChange={(event) => {
                setQuantity(event.target.value);
              }}
            />
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={!variant}
            onClick={() => {
              if (!variant) return;
              onAdd({
                variantId: variant.id,
                label: `${product.title} — ${variant.title}`,
                quantity: Math.max(1, Math.min(999, Math.round(Number(quantity)) || 1)),
              });
              setProduct(null);
              setQuery("");
            }}
          >
            <PlusIcon aria-hidden />
            Add to test basket
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setProduct(null);
            }}
          >
            Choose another product
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <SearchBox
        label="Add a product to the test basket"
        placeholder="Search products"
        value={query}
        onChange={setQuery}
      />
      {loadingProduct && <Skeleton className="h-10 w-full" />}
      {productError && <p className="text-danger text-sm">{productError}</p>}
      {search.state === "loading" && <Skeleton className="h-24 w-full" />}
      {search.state === "error" && <p className="text-danger text-sm">{search.error}</p>}
      {search.state === "ready" && search.results.length === 0 && (
        <p className="text-text-secondary text-sm">No products match “{search.q}”.</p>
      )}
      {search.state === "ready" && search.results.length > 0 && (
        <ul className="border-border-subtle divide-border-subtle divide-y rounded-md border">
          {search.results.map((item) => (
            <li
              key={item.id}
              className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm"
            >
              <span className="min-w-0 truncate">{item.title}</span>
              <span className="flex items-center gap-2">
                {item.price && (
                  <MoneyText money={item.price} className="text-text-secondary text-xs" />
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label={`Choose ${item.title}`}
                  onClick={() => {
                    void choose(item.id);
                  }}
                >
                  Choose
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
