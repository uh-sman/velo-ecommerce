"use client";

import type { Money, Schema } from "@velo/api-client";
import { CheckCircle2Icon, MailIcon, PhoneIcon } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";

import {
  EmptyState,
  ErrorState,
  MoneyText,
  PageHeader,
  Section,
  Table,
  formatDate,
  formatDateTime,
  td,
  th,
} from "@/components/page";
import { IfCan } from "@/components/shell/me-context";
import { StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ui/sonner";
import { callApi, fieldErrors } from "@/lib/api-browser";

import { TextAreaField, fullName, problemMessage, useResource } from "./shared";

type Detail = Schema<"CustomerDetailView">;
type Note = Schema<"NoteView">;

/** Fields the API returns as untyped dictionaries, read defensively. */
interface AddressRow {
  id: string;
  name: string;
  lines: string[];
  isDefault: boolean;
}

interface OrderRow {
  id: string;
  number: string;
  status: string;
  placedAt: string;
  total: Money | null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function toAddress(raw: Record<string, unknown>, index: number): AddressRow {
  const cityLine = [text(raw["city"]), text(raw["region"]), text(raw["postal_code"])]
    .filter(Boolean)
    .join(", ");
  return {
    id: text(raw["id"]) || String(index),
    name: [text(raw["first_name"]), text(raw["last_name"])].filter(Boolean).join(" "),
    lines: [text(raw["line1"]), text(raw["line2"]), cityLine, text(raw["country_code"])].filter(
      Boolean,
    ),
    isDefault: raw["is_default_shipping"] === true,
  };
}

function toOrder(raw: Record<string, unknown>, index: number): OrderRow {
  const total = raw["total"] as { amount?: unknown; currency?: unknown } | null | undefined;
  return {
    id: text(raw["id"]) || String(index),
    number: text(raw["number"]),
    status: text(raw["status"]),
    placedAt: text(raw["placed_at"]),
    total:
      total && typeof total.amount === "number" && typeof total.currency === "string"
        ? { amount: total.amount, currency: total.currency }
        : null,
  };
}

export function CustomerProfile({ id }: { id: string }) {
  const { load, reload, mutate } = useResource(
    () =>
      callApi((client) =>
        client.GET("/api/v1/admin/customers/{customer_id}", {
          params: { path: { customer_id: id } },
        }),
      ),
    id,
  );

  if (load.state === "loading") return <ProfileSkeleton />;
  if (load.state === "error") {
    return (
      <>
        <PageHeader title="Customer" />
        <ErrorState title={load.message} onRetry={reload} />
      </>
    );
  }
  const customer = load.data;
  const name = fullName(customer) || customer.email;
  const addresses = customer.addresses.map(toAddress);
  const orders = customer.recent_orders.map(toOrder);

  return (
    <>
      <PageHeader
        title={name}
        description={`Customer since ${formatDate(customer.created_at)}${
          customer.status !== "active" ? ` · ${customer.status}` : ""
        }`}
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Section title="Summary">
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Lifetime value">
                <MoneyText money={customer.lifetime_value} />
              </Stat>
              <Stat label="Orders">{String(customer.order_count)}</Stat>
              <Stat label="First order">{formatDate(customer.first_order_at)}</Stat>
              <Stat label="Last order">{formatDate(customer.last_order_at)}</Stat>
            </dl>
          </Section>

          <Section title="Recent orders">
            {orders.length === 0 ? (
              <EmptyState title="No orders yet">
                Orders appear here once this customer checks out.
              </EmptyState>
            ) : (
              <Table label="Recent orders">
                <thead>
                  <tr>
                    <th scope="col" className={th}>
                      Order
                    </th>
                    <th scope="col" className={th}>
                      Placed
                    </th>
                    <th scope="col" className={th}>
                      Status
                    </th>
                    <th scope="col" className={`${th} text-right`}>
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((order) => (
                    <tr key={order.id}>
                      <td className={td}>
                        <Link
                          href={`/orders/${order.id}`}
                          className="inline-flex min-h-11 items-center font-medium underline-offset-4 hover:underline"
                        >
                          {order.number ? `#${order.number}` : "View order"}
                        </Link>
                      </td>
                      <td className={td}>{formatDate(order.placedAt || null)}</td>
                      <td className={td}>
                        {order.status && <StatusBadge status={order.status} />}
                      </td>
                      <td className={`${td} text-right`}>
                        <MoneyText money={order.total} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Section>

          <Notes
            customerId={customer.id}
            notes={customer.notes}
            onAdded={(note) => {
              mutate((current: Detail) => ({ ...current, notes: [note, ...current.notes] }));
            }}
          />
        </div>

        <div className="flex flex-col gap-4">
          <Section title="Contact">
            <ul className="flex flex-col gap-3 text-sm">
              <li className="flex items-start gap-2">
                <MailIcon className="text-text-tertiary mt-0.5 size-4 shrink-0" aria-hidden />
                <span className="min-w-0 break-all">
                  <a
                    href={`mailto:${customer.email}`}
                    className="underline-offset-4 hover:underline"
                  >
                    {customer.email}
                  </a>
                  <span className="text-text-secondary block">
                    {customer.email_verified ? (
                      <span className="inline-flex items-center gap-1">
                        <CheckCircle2Icon className="text-success size-3.5" aria-hidden />
                        Verified
                      </span>
                    ) : (
                      "Not verified"
                    )}
                  </span>
                </span>
              </li>
              <li className="flex items-start gap-2">
                <PhoneIcon className="text-text-tertiary mt-0.5 size-4 shrink-0" aria-hidden />
                {customer.phone ? (
                  <a href={`tel:${customer.phone}`} className="underline-offset-4 hover:underline">
                    {customer.phone}
                  </a>
                ) : (
                  <span className="text-text-secondary">No phone number</span>
                )}
              </li>
              <li className="text-text-secondary">
                {customer.marketing_opt_in
                  ? "Subscribed to marketing emails"
                  : "Not subscribed to marketing emails"}
              </li>
            </ul>
          </Section>

          <Section title="Addresses">
            {addresses.length === 0 ? (
              <p className="text-text-secondary text-sm">No saved addresses.</p>
            ) : (
              <ul className="flex flex-col gap-4">
                {addresses.map((address) => (
                  <li key={address.id} className="text-sm">
                    {address.isDefault && (
                      <p className="text-text-secondary mb-1 text-xs font-medium uppercase">
                        Default shipping
                      </p>
                    )}
                    <address className="not-italic">
                      {address.name && <span className="block font-medium">{address.name}</span>}
                      {address.lines.map((line) => (
                        <span key={line} className="block">
                          {line}
                        </span>
                      ))}
                    </address>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>
    </>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-text-secondary text-xs font-medium uppercase">{label}</dt>
      <dd className="mt-1 text-lg font-semibold tabular-nums">{children}</dd>
    </div>
  );
}

function Notes({
  customerId,
  notes,
  onAdded,
}: {
  customerId: string;
  notes: Note[];
  onAdded: (note: Note) => void;
}) {
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!body.trim()) {
      setError("Write the note first.");
      return;
    }
    setSaving(true);
    setError(undefined);
    const outcome = await callApi((client) =>
      client.POST("/api/v1/admin/customers/{customer_id}/notes", {
        params: { path: { customer_id: customerId } },
        body: { body: body.trim() },
      }),
    );
    setSaving(false);
    if (!outcome.ok) {
      setError(fieldErrors(outcome.problem)["body"] ?? problemMessage(outcome.problem));
      return;
    }
    onAdded(outcome.data);
    setBody("");
    notify.success("Note added");
  }

  return (
    <Section title="Notes">
      <IfCan permission="customers:write">
        <form
          onSubmit={(event) => void onSubmit(event)}
          noValidate
          className="mb-4 flex flex-col gap-2"
        >
          <TextAreaField
            label="Add a note"
            hint="Only staff can see notes."
            maxLength={4000}
            value={body}
            error={error}
            onChange={(event) => {
              setBody(event.target.value);
              if (error) setError(undefined);
            }}
          />
          <div>
            <Button type="submit" loading={saving}>
              Add note
            </Button>
          </div>
        </form>
      </IfCan>
      {notes.length === 0 ? (
        <p className="text-text-secondary text-sm">No notes yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {notes.map((note) => (
            <li key={note.id} className="border-border-subtle rounded-md border p-3 text-sm">
              <p className="whitespace-pre-wrap">{note.body}</p>
              <p className="text-text-secondary mt-2 text-xs">
                {note.author_email ?? "Someone"} · {formatDateTime(note.created_at)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function ProfileSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading customer">
      <Skeleton className="mb-6 h-8 w-64" />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
        <div className="flex flex-col gap-4">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    </div>
  );
}
