import { formatMoney } from "@velo/api-client";
import type { Metadata } from "next";
import Link from "next/link";

import { StatusBadge } from "@/components/orders/status";
import { serverClient } from "@/lib/api-server";
import { formatDate } from "@/lib/utils";

export const metadata: Metadata = { title: "Returns" };

const STEPS = ["requested", "approved", "in_transit", "received", "refunded"];

/*
 * PAGE-SPECS.md §2.6: every return with where it is. Returns start from an
 * order ("Request a return" on its page); this is the list to follow them.
 */
export default async function ReturnsPage() {
  const client = await serverClient();
  const { data: orders } = await client.GET("/api/v1/orders", {
    params: { query: { limit: 50 } },
    cache: "no-store",
  });
  const details = await Promise.all(
    (orders?.data ?? []).map((order) =>
      client
        .GET("/api/v1/orders/{number}", {
          params: { path: { number: order.number } },
          cache: "no-store",
        })
        .then((r) => r.data ?? null),
    ),
  );
  const returns = details
    .filter((order) => order !== null)
    .flatMap((order) => order.returns.map((returned) => ({ order, returned })))
    .sort((a, b) => b.returned.created_at.localeCompare(a.returned.created_at));

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Returns</h1>
      {returns.length === 0 ? (
        <p className="text-text-secondary">
          No returns. To send something back, open the order and choose “Request a return”.{" "}
          <Link href="/account/orders" className="underline">
            Your orders
          </Link>
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {returns.map(({ order, returned }) => {
            const reached = STEPS.indexOf(returned.status);
            return (
              <li
                key={returned.id}
                className="border-border-subtle flex flex-col gap-3 rounded-lg border p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">
                    <span className="font-mono">{returned.rma_number}</span>
                    <span className="text-text-secondary font-normal">
                      {" "}
                      · order{" "}
                      <Link href={`/account/orders/${order.number}`} className="underline">
                        {order.number}
                      </Link>{" "}
                      · {formatDate(returned.created_at)}
                    </span>
                  </p>
                  <StatusBadge status={returned.status} />
                </div>
                {returned.status !== "rejected" && reached >= 0 && (
                  <ol
                    className="flex flex-wrap gap-x-4 gap-y-1 text-xs"
                    aria-label="Return progress"
                  >
                    {STEPS.map((step, index) => (
                      <li
                        key={step}
                        className={index <= reached ? "text-text-primary" : "text-text-tertiary"}
                      >
                        {index <= reached ? "● " : "○ "}
                        {step.replace("_", " ")}
                      </li>
                    ))}
                  </ol>
                )}
                {returned.status === "rejected" && returned.staff_note && (
                  <p className="text-sm">Reason: {returned.staff_note}</p>
                )}
                {returned.refund_amount && (
                  <p className="text-sm">
                    {formatMoney(returned.refund_amount)} refunded — 5–10 business days to your
                    card.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
