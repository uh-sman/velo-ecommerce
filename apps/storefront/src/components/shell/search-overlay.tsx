"use client";

import { formatMoney, type Schema } from "@velo/api-client";
import { ClockIcon, SearchIcon, XIcon } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { callApi } from "@/lib/api-browser";
import { forget, recall, RECENT_SEARCHES, remember } from "@/lib/recent";
import { cn } from "@/lib/utils";

type Card = Schema<"ProductCard">;
type Option = { kind: "product"; card: Card } | { kind: "query"; text: string; recent: boolean };

/*
 * The search overlay (PLANNING.md 10.2): results as you type, debounced 200 ms;
 * arrow keys move through them, Enter opens one or searches in full, Escape
 * closes. Recent searches show before the first keystroke. A combobox in the
 * ARIA sense: the input owns a listbox, and the active option is announced.
 */
export function SearchOverlay() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Card[]>([]);
  const [total, setTotal] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const [active, setActive] = useState(-1);
  const [loading, setLoading] = useState(false);
  const listId = useId();
  const latest = useRef(0);

  useEffect(() => {
    if (open) setRecent(recall(RECENT_SEARCHES));
  }, [open]);

  // "/" opens search from anywhere that is not a text field.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if (event.key === "/" && !typing) {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    const text = query.trim();
    setActive(-1);
    if (text.length < 2) {
      setHits([]);
      setTotal(0);
      return;
    }
    const ticket = ++latest.current;
    const timer = setTimeout(() => {
      setLoading(true);
      void callApi((client) =>
        client.GET("/api/v1/search", { params: { query: { q: text, limit: 6 } } }),
      ).then((outcome) => {
        if (ticket !== latest.current) return; // a newer keystroke won
        setLoading(false);
        if (outcome.ok) {
          setHits(outcome.data.hits);
          setTotal(outcome.data.total_hits);
        }
      });
    }, 200);
    return () => {
      clearTimeout(timer);
    };
  }, [query]);

  const options: Option[] =
    query.trim().length < 2
      ? recent.map((text) => ({ kind: "query" as const, text, recent: true }))
      : [
          ...hits.map((card) => ({ kind: "product" as const, card })),
          { kind: "query" as const, text: query.trim(), recent: false },
        ];

  function go(option: Option) {
    setOpen(false);
    if (option.kind === "product") {
      router.push(`/products/${option.card.slug}`);
    } else {
      setRecent(remember(RECENT_SEARCHES, option.text, 6));
      router.push(`/search?q=${encodeURIComponent(option.text)}`);
    }
    setQuery("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => (options.length ? (index + 1) % options.length : -1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (options.length ? (index - 1 + options.length) % options.length : -1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const chosen = options[active];
      if (chosen) go(chosen);
      else if (query.trim()) go({ kind: "query", text: query.trim(), recent: false });
    }
  }

  const optionId = (index: number) => `${listId}-option-${String(index)}`;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        className="hover:bg-accent flex size-11 items-center justify-center rounded-md"
        aria-label="Search"
        aria-keyshortcuts="/"
      >
        <SearchIcon className="size-5" aria-hidden />
      </DialogTrigger>
      <DialogContent
        className="top-4 translate-y-0 gap-0 p-0 sm:top-16 sm:max-w-2xl"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Search the store</DialogTitle>
        <div className="border-border-subtle flex items-center gap-2 border-b px-4">
          <SearchIcon className="text-text-tertiary size-5 shrink-0" aria-hidden />
          <input
            type="search"
            role="combobox"
            aria-expanded={options.length > 0}
            aria-controls={listId}
            aria-activedescendant={active >= 0 ? optionId(active) : undefined}
            aria-autocomplete="list"
            placeholder="Search products"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            onKeyDown={onKeyDown}
            className="h-14 flex-1 bg-transparent text-base outline-none"
          />
          <button
            type="button"
            onClick={() => {
              setOpen(false);
            }}
            className="hover:bg-accent flex size-11 items-center justify-center rounded-md"
            aria-label="Close search"
          >
            <XIcon className="size-5" aria-hidden />
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-2">
          {query.trim().length < 2 && recent.length > 0 && (
            <div className="text-text-secondary flex items-center justify-between px-2 py-1 text-xs font-medium uppercase">
              Recent searches
              <button
                type="button"
                className="underline"
                onClick={() => {
                  forget(RECENT_SEARCHES);
                  setRecent([]);
                }}
              >
                Clear
              </button>
            </div>
          )}
          <ul id={listId} role="listbox" aria-label="Search suggestions">
            {options.map((option, index) => (
              <li
                key={option.kind === "product" ? option.card.id : `q-${option.text}`}
                id={optionId(index)}
                role="option"
                aria-selected={index === active}
                onMouseEnter={() => {
                  setActive(index);
                }}
                onMouseDown={(event) => {
                  event.preventDefault(); // keep focus in the input
                  go(option);
                }}
                className={cn(
                  "flex min-h-12 cursor-pointer items-center gap-3 rounded-md px-2 py-2",
                  index === active && "bg-accent",
                )}
              >
                {option.kind === "product" ? (
                  <>
                    <span className="bg-surface-sunken relative size-10 shrink-0 overflow-hidden rounded">
                      {option.card.image && (
                        <Image
                          src={option.card.image.url}
                          alt=""
                          fill
                          sizes="40px"
                          className="object-cover"
                          unoptimized
                        />
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{option.card.title}</span>
                    <span className="text-text-secondary text-sm tabular-nums">
                      {formatMoney(option.card.price)}
                    </span>
                  </>
                ) : (
                  <>
                    {option.recent ? (
                      <ClockIcon className="text-text-tertiary size-4" aria-hidden />
                    ) : (
                      <SearchIcon className="text-text-tertiary size-4" aria-hidden />
                    )}
                    <span className="flex-1">
                      {option.recent
                        ? option.text
                        : `See all ${String(total)} results for “${option.text}”`}
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
          <p className="sr-only" aria-live="polite">
            {loading ? "Searching" : query.trim().length >= 2 ? `${String(total)} results` : ""}
          </p>
          {query.trim().length >= 2 && !loading && hits.length === 0 && (
            <p className="text-text-secondary px-2 py-6 text-center text-sm">
              No products match “{query.trim()}”. Try fewer words, or a different spelling.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
