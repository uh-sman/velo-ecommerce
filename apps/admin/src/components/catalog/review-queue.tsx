"use client";

import type { Schema } from "@velo/api-client";
import { BadgeCheckIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useId, useState } from "react";

import {
  Badge,
  Pager,
  problemMessage,
  runBatch,
  selectClass,
  useCursorList,
} from "@/components/catalog/shared";
import { EmptyState, ErrorState, formatDate } from "@/components/page";
import { useCan } from "@/components/shell/me-context";
import { StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ui/sonner";
import { callApi } from "@/lib/api-browser";

type Review = Schema<"AdminReviewView">;
type Status = "pending" | "approved" | "rejected";
type Decision = "approved" | "rejected";

const PAGE_SIZE = 50;

const EMPTY: Record<Status, string> = {
  pending: "Nothing waiting — every review has been moderated",
  approved: "No approved reviews yet",
  rejected: "No rejected reviews",
};

/*
 * The moderation queue. A decision takes the review out of the list at once
 * and puts it back where it was if the API refuses — moderators work through
 * dozens in a row, and waiting on each round trip is what makes queues pile up.
 */
export function ReviewQueue() {
  const canModerate = useCan("catalog:write");
  const statusId = useId();
  const [status, setStatus] = useState<Status>("pending");
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const fetchPage = useCallback(
    (cursor: string | null) =>
      callApi((client) =>
        client.GET("/api/v1/admin/reviews", {
          params: { query: { status, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) } },
        }),
      ),
    [status],
  );
  const list = useCursorList(fetchPage);
  const { state, setRows } = list;
  const rows = state.phase === "ready" ? state.rows : [];

  // Reviews carry only the product id; fetch each title once, for context.
  const productIds = [...new Set(rows.map((review) => review.product_id))]
    .filter((id) => !(id in titles))
    .join(",");
  useEffect(() => {
    if (!productIds) return;
    const ids = productIds.split(",");
    void runBatch(ids, async (id) => {
      const outcome = await callApi((client) =>
        client.GET("/api/v1/admin/products/{product_id}", {
          params: { path: { product_id: id } },
        }),
      );
      const title = outcome.ok ? outcome.data.title : "Product";
      setTitles((current) => ({ ...current, [id]: title }));
      return null;
    });
  }, [productIds]);

  const decide = async (review: Review, decision: Decision) => {
    const index = rows.findIndex((r) => r.id === review.id);
    setBusy((current) => new Set(current).add(review.id));
    setRows((current) => current.filter((r) => r.id !== review.id));
    const outcome = await callApi((client) =>
      client.PATCH("/api/v1/admin/reviews/{review_id}", {
        params: { path: { review_id: review.id } },
        body: { status: decision },
      }),
    );
    setBusy((current) => {
      const next = new Set(current);
      next.delete(review.id);
      return next;
    });
    if (outcome.ok) {
      notify.success(decision === "approved" ? "Review approved — now public" : "Review rejected");
      return;
    }
    // Put it back where it was.
    setRows((current) => {
      if (current.some((r) => r.id === review.id)) return current;
      const next = [...current];
      next.splice(Math.min(Math.max(index, 0), next.length), 0, review);
      return next;
    });
    notify.error(`Could not update the review: ${problemMessage(outcome.problem)}`);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={statusId} className="text-sm font-medium">
          Show
        </label>
        <select
          id={statusId}
          className={`${selectClass} w-fit`}
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as Status);
          }}
        >
          <option value="pending">Waiting for moderation</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>

      {state.phase === "loading" && (
        <div className="flex flex-col gap-3" aria-busy role="status" aria-label="Loading reviews">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-36" />
          ))}
        </div>
      )}
      {state.phase === "error" && (
        <ErrorState
          title={`We could not load reviews. ${problemMessage(state.problem)}`}
          onRetry={list.reload}
        />
      )}
      {state.phase === "ready" && rows.length === 0 && <EmptyState title={EMPTY[status]} />}

      {state.phase === "ready" && rows.length > 0 && (
        <div aria-busy={state.refreshing} className={state.refreshing ? "opacity-60" : undefined}>
          <ul className="flex flex-col gap-3" aria-label="Reviews">
            {rows.map((review) => (
              <li
                key={review.id}
                className="border-border-subtle bg-surface-raised flex flex-col gap-3 rounded-lg border p-4"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Stars rating={review.rating} />
                  <StatusBadge status={review.status} />
                  {review.verified_purchase && (
                    <Badge tone="success">
                      <BadgeCheckIcon className="mr-1 size-3.5" aria-hidden />
                      Verified purchase
                    </Badge>
                  )}
                  <span className="text-text-secondary text-sm">
                    {review.author ?? "Anonymous"} · {formatDate(review.created_at)}
                  </span>
                </div>
                <div>
                  {review.title && <p className="font-semibold">{review.title}</p>}
                  {review.body ? (
                    <p className="text-text-secondary mt-1 whitespace-pre-line text-sm">
                      {review.body}
                    </p>
                  ) : (
                    <p className="text-text-tertiary mt-1 text-sm">A rating with no text.</p>
                  )}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <Link
                    href={`/products/${review.product_id}`}
                    className="text-sm underline underline-offset-4"
                  >
                    {titles[review.product_id] ?? "View product"}
                  </Link>
                  {canModerate && (
                    <div className="flex gap-2">
                      {review.status !== "rejected" && (
                        <Button
                          variant="outline"
                          disabled={busy.has(review.id)}
                          onClick={() => void decide(review, "rejected")}
                        >
                          Reject
                        </Button>
                      )}
                      {review.status !== "approved" && (
                        <Button
                          disabled={busy.has(review.id)}
                          onClick={() => void decide(review, "approved")}
                        >
                          Approve
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <Pager
            page={list.page}
            pageSize={PAGE_SIZE}
            shown={rows.length}
            total={state.pagination.total_count}
            hasPrevious={list.hasPrevious}
            hasNext={list.hasNext}
            onPrevious={list.previous}
            onNext={list.next}
            noun="reviews"
          />
        </div>
      )}
    </div>
  );
}

function Stars({ rating }: { rating: number }) {
  return (
    <span className="text-warning tracking-wider" title={`${String(rating)} out of 5`}>
      <span aria-hidden>{"★".repeat(rating) + "☆".repeat(Math.max(0, 5 - rating))}</span>
      <span className="sr-only">{rating} out of 5 stars</span>
    </span>
  );
}
