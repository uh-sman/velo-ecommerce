import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Schema } from "@velo/api-client";
import { HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewQueue } from "@/components/catalog/review-queue";
import {
  adminProduct,
  deferred,
  pagination,
  review,
  spyOnToasts,
} from "@/test/fixtures/catalog-lists";
import { renderWithMe, staff } from "@/test/render";
import { fail, on, server } from "@/test/server";

type Review = Schema<"AdminReviewView">;

const REVIEWS = "/api/v1/admin/reviews";
const PRODUCT = "/api/v1/admin/products/{product_id}";
const REVIEW = "/api/v1/admin/reviews/{review_id}";

/** Serves reviews by status and records each query string. */
function serveReviews(
  byStatus: Partial<Record<string, Review[]>>,
  page: Partial<Schema<"PaginationInfo">> = {},
) {
  const queries: URLSearchParams[] = [];
  server.use(
    on("get", REVIEWS, ({ request }) => {
      const params = new URL(request.url).searchParams;
      queries.push(params);
      return HttpResponse.json({
        data: byStatus[params.get("status") ?? ""] ?? [],
        pagination: pagination(page),
      });
    }),
  );
  return queries;
}

function serveTitles(titles: Record<string, string>) {
  const asked: string[] = [];
  server.use(
    on("get", PRODUCT, ({ params }) => {
      const id = String(params["product_id"]);
      asked.push(id);
      const title = titles[id];
      return title === undefined
        ? HttpResponse.json(
            { type: "https://velo.dev/errors/not-found", title: "Not found", status: 404 },
            { status: 404 },
          )
        : HttpResponse.json(adminProduct({ id, title }));
    }),
  );
  return asked;
}

function reviewItems() {
  return within(screen.getByRole("list", { name: "Reviews" })).getAllByRole("listitem");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ReviewQueue", () => {
  it("loads the pending queue with each review's context", async () => {
    const queries = serveReviews({
      pending: [
        review({ id: "rev-1", product_id: "prod-1", verified_purchase: true }),
        review({
          id: "rev-2",
          product_id: "prod-2",
          author: null,
          title: null,
          body: null,
          rating: 2,
        }),
        review({ id: "rev-3", product_id: "prod-1", rating: 5 }),
      ],
    });
    const asked = serveTitles({ "prod-1": "Trail Runner" });
    renderWithMe(<ReviewQueue />);

    expect(screen.getByRole("status", { name: "Loading reviews" })).toBeInTheDocument();
    const items = await waitFor(reviewItems);
    expect(items).toHaveLength(3);
    expect(queries[0]?.get("status")).toBe("pending");
    expect(queries[0]?.get("limit")).toBe("50");
    expect(queries[0]?.has("cursor")).toBe(false);

    const [first, second] = items;
    if (!first || !second) throw new Error("expected two reviews");
    expect(within(first).getByText("4 out of 5 stars")).toBeInTheDocument();
    expect(within(first).getByText("Verified purchase")).toBeInTheDocument();
    expect(within(first).getByText("Love them")).toBeInTheDocument();
    expect(within(first).getByText("Great grip on wet rock.")).toBeInTheDocument();
    expect(within(first).getByText(/^Ada · /)).toBeInTheDocument();
    expect(within(second).getByText("2 out of 5 stars")).toBeInTheDocument();
    expect(within(second).getByText(/^Anonymous · /)).toBeInTheDocument();
    expect(within(second).getByText("A rating with no text.")).toBeInTheDocument();
    expect(within(second).queryByText("Verified purchase")).not.toBeInTheDocument();

    // Each product title is fetched once; a product that cannot be read shows a generic name.
    expect(await within(first).findByRole("link", { name: "Trail Runner" })).toHaveAttribute(
      "href",
      "/products/prod-1",
    );
    expect(await within(second).findByRole("link", { name: "Product" })).toHaveAttribute(
      "href",
      "/products/prod-2",
    );
    expect([...asked].sort()).toEqual(["prod-1", "prod-2"]);
    expect(screen.getByText("1–3 reviews")).toBeInTheDocument();
  });

  it("approves a review, taking it out of the queue at once", async () => {
    const toasts = spyOnToasts();
    serveReviews({ pending: [review({ id: "rev-1" }), review({ id: "rev-2", title: "Meh" })] });
    serveTitles({ "prod-1": "Trail Runner" });
    const gate = deferred();
    let sent: unknown;
    let target = "";
    server.use(
      on("patch", REVIEW, async ({ request, params }) => {
        sent = await request.json();
        target = String(params["review_id"]);
        await gate.promise;
        return HttpResponse.json(review({ id: "rev-1", status: "approved" }));
      }),
    );
    const user = userEvent.setup();
    renderWithMe(<ReviewQueue />);
    const [first] = await waitFor(reviewItems);
    if (!first) throw new Error("expected a review");

    await user.click(within(first).getByRole("button", { name: "Approve" }));
    // Optimistic: gone before the API answers.
    expect(reviewItems()).toHaveLength(1);
    expect(screen.queryByText("Love them")).not.toBeInTheDocument();
    gate.resolve();
    await waitFor(() => {
      expect(toasts.success).toHaveBeenCalledWith("Review approved — now public");
    });
    expect(sent).toEqual({ status: "approved" });
    expect(target).toBe("rev-1");
    expect(reviewItems()).toHaveLength(1);
  });

  it("puts a review back where it was when the API refuses the decision", async () => {
    const toasts = spyOnToasts();
    serveReviews({
      pending: [
        review({ id: "rev-1", title: "First" }),
        review({ id: "rev-2", title: "Second" }),
        review({ id: "rev-3", title: "Third" }),
      ],
    });
    serveTitles({ "prod-1": "Trail Runner" });
    server.use(
      fail("patch", REVIEW, {
        status: 409,
        slug: "conflict",
        title: "Conflict",
        detail: "Another moderator already decided.",
      }),
    );
    const user = userEvent.setup();
    renderWithMe(<ReviewQueue />);
    const items = await waitFor(reviewItems);
    await user.click(within(items[1] as HTMLElement).getByRole("button", { name: "Reject" }));

    await waitFor(() => {
      expect(toasts.error).toHaveBeenCalledWith(
        "Could not update the review: Another moderator already decided.",
      );
    });
    expect(
      reviewItems().map((item) => within(item).getByText(/First|Second|Third/).textContent),
    ).toEqual(["First", "Second", "Third"]);
    expect(
      within(reviewItems()[1] as HTMLElement).getByRole("button", { name: "Reject" }),
    ).toBeEnabled();
  });

  it("rejects with a confirmation toast", async () => {
    const toasts = spyOnToasts();
    serveReviews({ pending: [review()] });
    serveTitles({ "prod-1": "Trail Runner" });
    let sent: unknown;
    server.use(
      on("patch", REVIEW, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(review({ status: "rejected" }));
      }),
    );
    const user = userEvent.setup();
    renderWithMe(<ReviewQueue />);
    await user.click(await screen.findByRole("button", { name: "Reject" }));
    await waitFor(() => {
      expect(toasts.success).toHaveBeenCalledWith("Review rejected");
    });
    expect(sent).toEqual({ status: "rejected" });
    expect(
      screen.getByText("Nothing waiting — every review has been moderated"),
    ).toBeInTheDocument();
  });

  it("offers only the decision a review does not already have", async () => {
    const queries = serveReviews({
      approved: [review({ id: "rev-a", status: "approved" })],
      rejected: [review({ id: "rev-r", status: "rejected" })],
    });
    serveTitles({ "prod-1": "Trail Runner" });
    const user = userEvent.setup();
    renderWithMe(<ReviewQueue />);
    expect(
      await screen.findByText("Nothing waiting — every review has been moderated"),
    ).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Show"), "Approved");
    const [approved] = await waitFor(reviewItems);
    if (!approved) throw new Error("expected a review");
    expect(within(approved).getByRole("button", { name: "Reject" })).toBeInTheDocument();
    expect(within(approved).queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Show"), "Rejected");
    await waitFor(() => {
      expect(queries.at(-1)?.get("status")).toBe("rejected");
    });
    const rejected = await screen.findByRole("button", { name: "Approve" });
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
    expect(rejected).toBeEnabled();
  });

  it("says when there is nothing approved or rejected yet", async () => {
    serveReviews({});
    const user = userEvent.setup();
    renderWithMe(<ReviewQueue />);
    await screen.findByText("Nothing waiting — every review has been moderated");
    await user.selectOptions(screen.getByLabelText("Show"), "approved");
    expect(await screen.findByText("No approved reviews yet")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Show"), "rejected");
    expect(await screen.findByText("No rejected reviews")).toBeInTheDocument();
  });

  it("hides moderation from staff without catalog:write", async () => {
    serveReviews({ pending: [review()] });
    serveTitles({ "prod-1": "Trail Runner" });
    renderWithMe(<ReviewQueue />, {
      me: staff({ role: "support", permissions: ["admin:access", "orders:read"] }),
    });
    await screen.findByRole("link", { name: "Trail Runner" });
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
  });

  it("shows the API's problem and retries on request", async () => {
    let calls = 0;
    server.use(
      on("get", REVIEWS, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json(
              {
                type: "https://velo.dev/errors/forbidden",
                title: "Forbidden",
                status: 403,
                detail: "You cannot see reviews.",
              },
              { status: 403 },
            )
          : HttpResponse.json({ data: [], pagination: pagination() });
      }),
    );
    const user = userEvent.setup();
    renderWithMe(<ReviewQueue />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We could not load reviews. You cannot see reviews.",
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByText("Nothing waiting — every review has been moderated"),
    ).toBeInTheDocument();
    expect(calls).toBe(2);
  });

  it("pages through the queue with the API's cursor", async () => {
    const queries: URLSearchParams[] = [];
    server.use(
      on("get", REVIEWS, ({ request }) => {
        const params = new URL(request.url).searchParams;
        queries.push(params);
        const second = params.get("cursor") === "page-2";
        return HttpResponse.json({
          data: [
            review({ id: second ? "rev-2" : "rev-1", title: second ? "Page two" : "Page one" }),
          ],
          pagination: pagination({
            has_more: !second,
            next_cursor: second ? null : "page-2",
            total_count: 51,
          }),
        });
      }),
    );
    serveTitles({ "prod-1": "Trail Runner" });
    const user = userEvent.setup();
    renderWithMe(<ReviewQueue />);
    expect(await screen.findByText("Page one")).toBeInTheDocument();
    expect(screen.getByText("1–1 of 51 reviews")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Page two")).toBeInTheDocument();
    expect(queries.at(-1)?.get("cursor")).toBe("page-2");
    expect(screen.getByText("51–51 of 51 reviews")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByText("Page one")).toBeInTheDocument();
    expect(queries.at(-1)?.has("cursor")).toBe(false);
  });
});
