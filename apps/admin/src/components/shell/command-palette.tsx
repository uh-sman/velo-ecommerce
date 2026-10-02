"use client";

import { ArrowRightIcon, ClipboardListIcon, SearchIcon, UserIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";

import { useMe } from "@/components/shell/me-context";
import { NAV } from "@/components/shell/nav";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { callApi } from "@/lib/api-browser";
import { can } from "@/lib/permissions";
import { cn } from "@/lib/utils";

interface Action {
  id: string;
  label: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
  href: string;
}

/*
 * ⌘K: jump to any page this role can open, or find an order by number, email
 * or SKU, or a customer by name or email — keyboard first, a combobox with
 * the active option announced.
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const me = useMe();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Action[]>([]);
  const [active, setActive] = useState(0);
  const listId = useId();

  useEffect(() => {
    if (!open) {
      setQuery("");
      setFound([]);
    }
  }, [open]);

  // Orders and customers, debounced.
  useEffect(() => {
    const text = query.trim();
    if (text.length < 3) {
      setFound([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      const lookups: Promise<Action[]>[] = [];
      if (can(me.permissions, "orders:read")) {
        lookups.push(
          callApi((client) =>
            client.GET("/api/v1/admin/orders", { params: { query: { q: text, limit: 5 } } }),
          ).then((outcome) =>
            outcome.ok
              ? outcome.data.data.map((order) => ({
                  id: `order-${order.id}`,
                  label: `Order ${order.number}`,
                  hint: `${order.email} · ${order.status.replace(/_/g, " ")}`,
                  icon: ClipboardListIcon,
                  href: `/orders/${order.id}`,
                }))
              : [],
          ),
        );
      }
      if (can(me.permissions, "customers:read")) {
        lookups.push(
          callApi((client) =>
            client.GET("/api/v1/admin/customers", { params: { query: { q: text, limit: 5 } } }),
          ).then((outcome) =>
            outcome.ok
              ? outcome.data.data.map((customer) => ({
                  id: `customer-${customer.id}`,
                  label:
                    [customer.first_name, customer.last_name].filter(Boolean).join(" ") ||
                    customer.email,
                  hint: `Customer · ${customer.email}`,
                  icon: UserIcon,
                  href: `/customers/${customer.id}`,
                }))
              : [],
          ),
        );
      }
      void Promise.all(lookups).then((groups) => {
        if (live) setFound(groups.flat());
      });
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, me.permissions]);

  const pages = useMemo<Action[]>(() => {
    const text = query.trim().toLowerCase();
    return NAV.filter((item) => can(me.permissions, item.permission))
      .filter(
        (item) =>
          !text || item.label.toLowerCase().includes(text) || (item.keywords ?? "").includes(text),
      )
      .map((item) => ({
        id: `page-${item.href}`,
        label: item.label,
        hint: "Go to page",
        icon: item.icon,
        href: item.href,
      }));
  }, [query, me.permissions]);

  const actions = [...pages, ...found];

  useEffect(() => {
    setActive(0);
  }, [query, found.length]);

  function go(action: Action | undefined) {
    if (!action) return;
    onOpenChange(false);
    router.push(action.href);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => (actions.length ? (index + 1) % actions.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (actions.length ? (index - 1 + actions.length) % actions.length : 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      go(actions[active]);
    }
  }

  const optionId = (index: number) => `${listId}-${String(index)}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-16 translate-y-0 gap-0 p-0 sm:max-w-xl" showCloseButton={false}>
        <DialogTitle className="sr-only">Search or jump to</DialogTitle>
        <div className="border-border-subtle flex items-center gap-2 border-b px-3">
          <SearchIcon className="text-text-tertiary size-4" aria-hidden />
          <input
            role="combobox"
            aria-expanded={actions.length > 0}
            aria-controls={listId}
            aria-activedescendant={actions.length ? optionId(active) : undefined}
            aria-autocomplete="list"
            placeholder="Pages, orders by number or email, customers…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            onKeyDown={onKeyDown}
            className="h-12 flex-1 bg-transparent text-base outline-none"
          />
        </div>
        <ul
          id={listId}
          role="listbox"
          aria-label="Results"
          className="max-h-96 overflow-y-auto p-2"
        >
          {actions.map((action, index) => (
            <li
              key={action.id}
              id={optionId(index)}
              role="option"
              aria-selected={index === active}
              onMouseEnter={() => {
                setActive(index);
              }}
              onMouseDown={(event) => {
                event.preventDefault();
                go(action);
              }}
              className={cn(
                "flex h-11 cursor-pointer items-center gap-3 rounded-md px-2 text-sm",
                index === active && "bg-accent",
              )}
            >
              <action.icon className="text-text-secondary size-4" />
              <span className="flex-1 truncate">{action.label}</span>
              <span className="text-text-tertiary truncate text-xs">{action.hint}</span>
              {index === active && <ArrowRightIcon className="size-4" aria-hidden />}
            </li>
          ))}
          {actions.length === 0 && (
            <li className="text-text-secondary px-2 py-6 text-center text-sm">Nothing matches.</li>
          )}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
