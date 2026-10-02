"use client";

import type { Schema } from "@velo/api-client";
import { BadgeCheckIcon, StarIcon } from "lucide-react";
import Link from "next/link";
import { useId, useState, type FormEvent } from "react";

import { RatingStars } from "@/components/commerce/price";
import { FormAlert, TextField } from "@/components/forms/fields";
import { Button } from "@/components/ui/button";
import { callApi, fieldErrors, problemSlug } from "@/lib/api-browser";
import { cn } from "@/lib/utils";

type Review = Schema<"ReviewView">;
type Summary = Schema<"ReviewSummary">;

/*
 * Reviews (PLANNING.md 10.3): the distribution as labelled bars, the approved
 * reviews newest first with "Load more", and the form — for a signed-in
 * customer. Submitted reviews are moderated; the form says so.
 */
export function Reviews({
  slug,
  summary,
  first,
  nextCursor,
  signedIn,
}: {
  slug: string;
  summary: Summary | null;
  first: Review[];
  nextCursor: string | null;
  signedIn: boolean;
}) {
  const [reviews, setReviews] = useState(first);
  const [cursor, setCursor] = useState(nextCursor);
  const [loading, setLoading] = useState(false);

  async function more() {
    if (!cursor) return;
    setLoading(true);
    const outcome = await callApi((client) =>
      client.GET("/api/v1/products/{slug}/reviews", {
        params: { path: { slug }, query: { cursor, limit: 10 } },
      }),
    );
    setLoading(false);
    if (outcome.ok) {
      setReviews((current) => [...current, ...outcome.data.data]);
      setCursor(outcome.data.pagination.next_cursor ?? null);
    }
  }

  const count = summary?.count ?? 0;
  return (
    <section id="reviews" aria-labelledby="reviews-heading" className="flex flex-col gap-6">
      <h2 id="reviews-heading" className="text-2xl font-semibold tracking-tight">
        Reviews
      </h2>
      <div className="grid gap-8 lg:grid-cols-[18rem_1fr]">
        <div className="flex flex-col gap-4">
          {count > 0 && summary ? (
            <>
              <div className="flex items-center gap-3">
                <span className="text-4xl font-semibold tabular-nums">
                  {summary.average.toFixed(1)}
                </span>
                <RatingStars average={summary.average} count={count} />
              </div>
              <dl className="flex flex-col gap-1 text-sm">
                {[5, 4, 3, 2, 1].map((star) => {
                  const n = summary.distribution[String(star)] ?? 0;
                  const share = count ? Math.round((n / count) * 100) : 0;
                  return (
                    <div key={star} className="flex items-center gap-2">
                      <dt className="flex w-10 items-center gap-0.5">
                        {star}
                        <StarIcon className="fill-warning text-warning size-3" aria-hidden />
                        <span className="sr-only">stars</span>
                      </dt>
                      <dd className="flex flex-1 items-center gap-2">
                        <span className="bg-border-subtle h-2 flex-1 overflow-hidden rounded-full">
                          <span
                            className="bg-warning block h-full"
                            style={{ width: `${String(share)}%` }}
                          />
                        </span>
                        <span className="text-text-secondary w-8 text-right tabular-nums">{n}</span>
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </>
          ) : (
            <p className="text-text-secondary">No reviews yet. Be the first.</p>
          )}
          {signedIn ? (
            <ReviewForm slug={slug} />
          ) : (
            <p className="text-sm">
              <Link
                href={`/sign-in?next=${encodeURIComponent(`/products/${slug}#reviews`)}`}
                className="underline"
              >
                Sign in
              </Link>{" "}
              to write a review.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-6">
          <ul className="divide-border-subtle flex flex-col divide-y">
            {reviews.map((review) => (
              <li key={review.id} className="flex flex-col gap-2 py-4 first:pt-0">
                <div className="flex flex-wrap items-center gap-2">
                  <RatingStars average={review.rating} />
                  {review.title && <p className="font-medium">{review.title}</p>}
                </div>
                {review.body && (
                  <p className="text-text-secondary whitespace-pre-line">{review.body}</p>
                )}
                <p className="text-text-tertiary flex flex-wrap items-center gap-2 text-xs">
                  {review.author ?? "A customer"} ·{" "}
                  {new Date(review.created_at).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}
                  {review.verified_purchase && (
                    <span className="text-success inline-flex items-center gap-1">
                      <BadgeCheckIcon className="size-3.5" aria-hidden /> Verified purchase
                    </span>
                  )}
                </p>
              </li>
            ))}
          </ul>
          {cursor && (
            <Button
              variant="outline"
              className="self-start"
              loading={loading}
              onClick={() => void more()}
            >
              More reviews
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

function ReviewForm({ slug }: { slug: string }) {
  const [rating, setRating] = useState(0);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);
  const bodyId = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (rating < 1) {
      setError("Choose a star rating.");
      return;
    }
    setPending(true);
    setError(null);
    const outcome = await callApi((client) =>
      client.POST("/api/v1/products/{slug}/reviews", {
        params: { path: { slug } },
        body: { rating, title: title || null, body: body || null },
      }),
    );
    setPending(false);
    if (outcome.ok) {
      setDone(true);
      return;
    }
    setError(
      problemSlug(outcome.problem) === "already-reviewed"
        ? "You have already reviewed this product."
        : (Object.values(fieldErrors(outcome.problem))[0] ?? outcome.problem.title),
    );
  }

  if (done) {
    return (
      <FormAlert tone="success" title="Thank you for your review">
        It will appear once our team has checked it, usually within a day.
      </FormAlert>
    );
  }
  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="border-border-subtle flex flex-col gap-3 rounded-lg border p-4"
      noValidate
    >
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Your rating</legend>
        <div className="flex gap-1">
          {[1, 2, 3, 4, 5].map((star) => (
            <label key={star} className="cursor-pointer">
              <input
                type="radio"
                name="rating"
                value={star}
                checked={rating === star}
                onChange={() => {
                  setRating(star);
                }}
                className="peer sr-only"
              />
              <span className="sr-only">
                {star} {star === 1 ? "star" : "stars"}
              </span>
              <StarIcon
                aria-hidden
                className={cn(
                  "peer-focus-visible:ring-ring/50 size-8 rounded peer-focus-visible:ring-[3px]",
                  star <= rating ? "fill-warning text-warning" : "text-border-strong",
                )}
              />
            </label>
          ))}
        </div>
      </fieldset>
      <TextField
        label="Title"
        optional
        value={title}
        maxLength={120}
        onChange={(event) => {
          setTitle(event.target.value);
        }}
      />
      <div className="flex flex-col gap-1.5">
        <label htmlFor={bodyId} className="text-sm font-medium">
          Review <span className="text-text-tertiary font-normal">(optional)</span>
        </label>
        <textarea
          id={bodyId}
          rows={4}
          maxLength={5000}
          value={body}
          onChange={(event) => {
            setBody(event.target.value);
          }}
          className="border-border-default bg-surface-raised focus-visible:ring-ring/50 rounded-md border p-3 text-base outline-none focus-visible:ring-[3px]"
        />
      </div>
      {error && (
        <p role="alert" className="text-danger text-sm">
          {error}
        </p>
      )}
      <Button type="submit" loading={pending} className="self-start">
        Submit review
      </Button>
    </form>
  );
}
