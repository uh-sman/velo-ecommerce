"use client";

import type { Schema } from "@velo/api-client";
import { SearchIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { EmptyState, ErrorState, MoneyText, Table, formatDate, td, th } from "@/components/page";
import { Input } from "@/components/ui/input";
import { callApi } from "@/lib/api-browser";

import { LoadMore, TableSkeleton, fullName, useCursorList, useDebounced } from "./shared";

type Customer = Schema<"CustomerView">;

/** Customers, newest first, searchable by email or name (PLANNING.md Phase 11). */
export function CustomerList() {
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim());
  const list = useCursorList<Customer>(
    (cursor) =>
      callApi((client) =>
        client.GET("/api/v1/admin/customers", {
          params: { query: { q: q || null, cursor, limit: 50 } },
        }),
      ),
    q,
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="relative max-w-md">
        <label htmlFor="customer-search" className="sr-only">
          Search customers by email or name
        </label>
        <SearchIcon
          className="text-text-tertiary pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2"
          aria-hidden
        />
        <Input
          id="customer-search"
          type="search"
          placeholder="Search by email or name"
          className="pl-9"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
      </div>

      {list.state === "loading" && <TableSkeleton label="Loading customers" />}
      {list.state === "error" && (
        <ErrorState title={list.error ?? "We could not load customers."} onRetry={list.retry} />
      )}
      {list.state === "ready" && list.items.length === 0 && (
        <EmptyState title={q ? `No customers match “${q}”` : "No customers yet"}>
          {q
            ? "Try part of an email address or a surname."
            : "Customers appear here when they create an account or place an order."}
        </EmptyState>
      )}
      {list.state === "ready" && list.items.length > 0 && (
        <>
          <Table label="Customers">
            <thead>
              <tr>
                <th scope="col" className={th}>
                  Name
                </th>
                <th scope="col" className={th}>
                  Email
                </th>
                <th scope="col" className={`${th} text-right`}>
                  Orders
                </th>
                <th scope="col" className={`${th} text-right`}>
                  Lifetime value
                </th>
                <th scope="col" className={th}>
                  Last order
                </th>
                <th scope="col" className={th}>
                  Joined
                </th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((customer) => (
                <tr key={customer.id} className="hover:bg-accent/50">
                  <td className={td}>
                    <Link
                      href={`/customers/${customer.id}`}
                      className="inline-flex min-h-11 items-center font-medium underline-offset-4 hover:underline"
                    >
                      {fullName(customer) || <span className="text-text-secondary">No name</span>}
                    </Link>
                    {customer.role !== "customer" && (
                      <span className="bg-surface-sunken text-text-secondary ml-2 rounded-sm px-1.5 py-0.5 text-xs">
                        Staff
                      </span>
                    )}
                  </td>
                  <td className={`${td} break-all`}>{customer.email}</td>
                  <td className={`${td} text-right tabular-nums`}>
                    {String(customer.order_count)}
                  </td>
                  <td className={`${td} text-right`}>
                    <MoneyText money={customer.lifetime_value} />
                  </td>
                  <td className={td}>{formatDate(customer.last_order_at)}</td>
                  <td className={td}>{formatDate(customer.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <LoadMore
            hasMore={list.hasMore}
            loading={list.loadingMore}
            error={list.moreError}
            onLoadMore={list.loadMore}
            shown={list.items.length}
            total={list.total}
            noun="customers"
          />
        </>
      )}
    </div>
  );
}
