import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { Reviews } from "@/components/product/reviews";
import { review } from "@/test/fixtures/commerce";
import { fail, on, server } from "@/test/server";

const summary = { average: 4.25, count: 4, distribution: { "5": 2, "4": 1, "3": 1 } };

function renderReviews(props: Partial<Parameters<typeof Reviews>[0]> = {}) {
  return render(
    <Reviews
      slug="trail-tee"
      summary={summary}
      first={[review()]}
      nextCursor={null}
      signedIn={false}
      {...props}
    />,
  );
}

describe("Reviews", () => {
  it("shows the average and the distribution as labelled rows", () => {
    renderReviews();
    const section = screen.getByRole("region", { name: "Reviews" });
    expect(section).toHaveAttribute("id", "reviews");
    expect(within(section).getByText("4.3")).toBeInTheDocument();
    expect(within(section).getByText("Rated 4.3 out of 5 from 4 reviews")).toBeInTheDocument();
    const terms = within(section).getAllByRole("term");
    const counts = within(section).getAllByRole("definition");
    expect(terms.map((term) => term.textContent)).toEqual([
      "5stars",
      "4stars",
      "3stars",
      "2stars",
      "1stars",
    ]);
    expect(counts.map((count) => count.textContent)).toEqual(["2", "1", "1", "0", "0"]);
  });

  it("invites the first review when there are none", () => {
    renderReviews({ summary: null, first: [] });
    expect(screen.getByText("No reviews yet. Be the first.")).toBeInTheDocument();
    expect(screen.queryByRole("term")).not.toBeInTheDocument();
  });

  it("treats a zero-count summary as no reviews", () => {
    renderReviews({ summary: { average: 0, count: 0, distribution: {} }, first: [] });
    expect(screen.getByText("No reviews yet. Be the first.")).toBeInTheDocument();
  });

  it("asks a guest to sign in and come back to the reviews", () => {
    renderReviews();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/sign-in?next=%2Fproducts%2Ftrail-tee%23reviews",
    );
    expect(screen.queryByRole("button", { name: "Submit review" })).not.toBeInTheDocument();
  });

  it("lists reviews with author, title, body and verified badge", () => {
    renderReviews({
      first: [
        review(),
        review({
          id: "rev-2",
          author: null,
          title: null,
          body: null,
          verified_purchase: false,
          rating: 2,
        }),
      ],
    });
    const items = within(screen.getAllByRole("list")[0] ?? document.body).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Great tee");
    expect(items[0]).toHaveTextContent("Fits well.");
    expect(items[0]).toHaveTextContent("Ada");
    expect(items[0]).toHaveTextContent("Verified purchase");
    expect(items[1]).toHaveTextContent("A customer");
    expect(items[1]).not.toHaveTextContent("Verified purchase");
    expect(items[1]).toHaveTextContent("Rated 2.0 out of 5");
  });

  it("loads more reviews from the cursor", async () => {
    let query: URLSearchParams | undefined;
    server.use(
      on("get", "/api/v1/products/{slug}/reviews", ({ request }) => {
        query = new URL(request.url).searchParams;
        return HttpResponse.json({
          data: [review({ id: "rev-9", title: "Second page" })],
          pagination: { has_more: false, limit: 10, next_cursor: null },
        });
      }),
    );
    renderReviews({ nextCursor: "c2" });
    await userEvent.setup().click(screen.getByRole("button", { name: "More reviews" }));
    expect(await screen.findByText("Second page")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More reviews" })).not.toBeInTheDocument();
    expect(query?.get("cursor")).toBe("c2");
    expect(query?.get("limit")).toBe("10");
  });

  it("keeps the button when more reviews cannot be loaded", async () => {
    let asked = false;
    server.use(
      on("get", "/api/v1/products/{slug}/reviews", () => {
        asked = true;
        return HttpResponse.json(
          { type: "https://velo.dev/errors/http-500", title: "Oops", status: 500 },
          { status: 500 },
        );
      }),
    );
    renderReviews({ nextCursor: "c2" });
    await userEvent.setup().click(screen.getByRole("button", { name: "More reviews" }));
    await waitFor(() => {
      expect(asked).toBe(true);
    });
    expect(await screen.findByRole("button", { name: "More reviews" })).toBeEnabled();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });
});

describe("Review form", () => {
  it("requires a star rating before sending", async () => {
    renderReviews({ signedIn: true });
    await userEvent.setup().click(screen.getByRole("button", { name: "Submit review" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a star rating.");
  });

  it("sends the rating with empty fields as null, then thanks the customer", async () => {
    let sent: unknown;
    server.use(
      on("post", "/api/v1/products/{slug}/reviews", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(review(), { status: 201 });
      }),
    );
    renderReviews({ signedIn: true });
    const user = userEvent.setup();
    const group = screen.getByRole("group", { name: "Your rating" });
    expect(within(group).getAllByRole("radio")).toHaveLength(5);
    await user.click(within(group).getByRole("radio", { name: "1 star" }));
    await user.click(within(group).getByRole("radio", { name: "4 stars" }));
    expect(within(group).getByRole("radio", { name: "4 stars" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Submit review" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Thank you for your review");
    expect(sent).toEqual({ rating: 4, title: null, body: null });
  });

  it("sends the title and body when given", async () => {
    let sent: unknown;
    server.use(
      on("post", "/api/v1/products/{slug}/reviews", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(review(), { status: 201 });
      }),
    );
    renderReviews({ signedIn: true });
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "5 stars" }));
    await user.type(screen.getByLabelText(/^Title/), "Love it");
    await user.type(screen.getByLabelText("Review (optional)"), "Wore it up a mountain.");
    await user.click(screen.getByRole("button", { name: "Submit review" }));
    await screen.findByRole("status");
    expect(sent).toEqual({ rating: 5, title: "Love it", body: "Wore it up a mountain." });
  });

  it("says so when the customer has already reviewed the product", async () => {
    server.use(
      fail("post", "/api/v1/products/{slug}/reviews", {
        status: 409,
        slug: "already-reviewed",
        title: "Conflict",
      }),
    );
    renderReviews({ signedIn: true });
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "3 stars" }));
    await user.click(screen.getByRole("button", { name: "Submit review" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You have already reviewed this product.",
    );
  });

  it("shows a field error, or the problem title", async () => {
    server.use(
      fail("post", "/api/v1/products/{slug}/reviews", {
        status: 422,
        errors: [{ field: "body", code: "too_long", message: "Keep it under 5000 characters." }],
      }),
    );
    renderReviews({ signedIn: true });
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "3 stars" }));
    await user.click(screen.getByRole("button", { name: "Submit review" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Keep it under 5000 characters.");

    server.use(
      fail("post", "/api/v1/products/{slug}/reviews", { status: 403, title: "Not allowed" }),
    );
    await user.click(screen.getByRole("button", { name: "Submit review" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Not allowed");
    });
  });
});
