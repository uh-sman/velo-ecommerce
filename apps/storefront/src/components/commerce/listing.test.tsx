import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { Listing } from "@/components/commerce/listing";
import { productCard } from "@/test/fixtures/commerce";
import { router, setNavigation } from "@/test/navigation";
import { fail, on, server } from "@/test/server";
import type { ListingState } from "@/lib/listing";

const base: ListingState = {
  sort: "newest",
  brands: [],
  min: null,
  max: null,
  inStock: false,
  cursor: null,
};

const first = [productCard()];
const second = productCard({ id: "prod-2", slug: "ridge-cap", title: "Ridge Cap" });

function renderListing(props: Partial<Parameters<typeof Listing>[0]> = {}) {
  return render(
    <Listing
      scope={{ category: "tops" }}
      state={base}
      cards={first}
      nextCursor={null}
      brands={["Velo", "Alpine"]}
      {...props}
    />,
  );
}

const sidebar = () => screen.getByRole("complementary", { name: "Filters" });

describe("Listing", () => {
  it("shows the total when known, otherwise how many are shown", () => {
    const view = renderListing({ total: 42 });
    expect(screen.getByText("42 products")).toBeInTheDocument();
    view.rerender(<Listing scope={{}} state={base} cards={first} nextCursor={null} brands={[]} />);
    expect(screen.getByText("1 shown")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Trail Tee" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("offers to clear filters when nothing matches", () => {
    renderListing({ cards: [] });
    expect(screen.getByText("No products match these filters")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Clear all filters" })).toHaveAttribute("href", "?");
  });

  it("loads more in place with the scope and filters, then focuses the first new product", async () => {
    let query: URLSearchParams | undefined;
    server.use(
      on("get", "/api/v1/products", ({ request }) => {
        query = new URL(request.url).searchParams;
        return HttpResponse.json({
          data: [second],
          pagination: { has_more: false, limit: 24, next_cursor: null },
        });
      }),
    );
    renderListing({ nextCursor: "c2", state: { ...base, sort: "price", min: 20 } });
    const more = screen.getByRole("link", { name: "Load more" });
    expect(more).toHaveAttribute("href", "?sort=price&min=20&cursor=c2");

    await userEvent.setup().click(more);
    expect(await screen.findByText("1 more products loaded.")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Ridge Cap" });
    await waitFor(() => {
      expect(link).toHaveFocus();
    });
    expect(screen.queryByRole("link", { name: "Load more" })).not.toBeInTheDocument();
    expect(screen.getByText("2 shown")).toBeInTheDocument();
    expect(query?.get("cursor")).toBe("c2");
    expect(query?.get("category")).toBe("tops");
    expect(query?.get("sort")).toBe("price");
    expect(query?.get("min_price")).toBe("2000");
  });

  it("announces a failed Load more and keeps the button", async () => {
    server.use(fail("get", "/api/v1/products", { status: 500 }));
    renderListing({ nextCursor: "c2" });
    await userEvent.setup().click(screen.getByRole("link", { name: "Load more" }));
    expect(
      await screen.findByText("More products could not be loaded. Try again."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Load more" })).toBeInTheDocument();
  });

  it("takes new server-rendered cards when the URL changes", () => {
    const view = renderListing();
    view.rerender(<Listing scope={{}} state={base} cards={[second]} nextCursor="c3" brands={[]} />);
    expect(screen.getByRole("link", { name: "Ridge Cap" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Trail Tee" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Load more" })).toBeInTheDocument();
  });

  it("navigates when the sort changes, dropping the cursor", async () => {
    setNavigation({ pathname: "/collections/summer" });
    renderListing({ state: { ...base, cursor: "c9" } });
    await userEvent.setup().selectOptions(screen.getByLabelText("Sort"), "Price: high to low");
    expect(router.push).toHaveBeenCalledWith("/collections/summer?sort=-price", {
      scroll: false,
    });
  });
});

describe("Listing filters", () => {
  it("filters to in-stock products", async () => {
    setNavigation({ pathname: "/products" });
    renderListing();
    await userEvent
      .setup()
      .click(within(sidebar()).getByRole("checkbox", { name: "In stock only" }));
    expect(router.push).toHaveBeenCalledWith("/products?in_stock=1", { scroll: false });
  });

  it("applies a price range in whole units and drops what is not a number", async () => {
    setNavigation({ pathname: "/products" });
    renderListing();
    const user = userEvent.setup();
    await user.type(within(sidebar()).getByLabelText("Minimum price"), "20");
    await user.type(within(sidebar()).getByLabelText("Maximum price"), "abc");
    await user.click(within(sidebar()).getByRole("button", { name: "Apply price" }));
    expect(router.push).toHaveBeenCalledWith("/products?min=20", { scroll: false });
  });

  it("applies an empty price form as no range", async () => {
    setNavigation({ pathname: "/products" });
    renderListing({ state: { ...base, max: 50 } });
    const user = userEvent.setup();
    const max = within(sidebar()).getByLabelText("Maximum price");
    expect(max).toHaveValue("50");
    await user.clear(max);
    await user.click(within(sidebar()).getByRole("button", { name: "Apply price" }));
    expect(router.push).toHaveBeenCalledWith("/products", { scroll: false });
  });

  it("adds and removes brands", async () => {
    setNavigation({ pathname: "/products" });
    const view = renderListing();
    const user = userEvent.setup();
    await user.click(within(sidebar()).getByRole("checkbox", { name: "Alpine" }));
    expect(router.push).toHaveBeenLastCalledWith("/products?brand=Alpine", { scroll: false });

    view.rerender(
      <Listing
        scope={{}}
        state={{ ...base, brands: ["Alpine", "Velo"] }}
        cards={first}
        nextCursor={null}
        brands={["Velo", "Alpine"]}
      />,
    );
    const velo = within(sidebar()).getByRole("checkbox", { name: "Velo" });
    expect(velo).toBeChecked();
    await user.click(velo);
    expect(router.push).toHaveBeenLastCalledWith("/products?brand=Alpine", { scroll: false });
  });

  it("hides the brand filter when there are no brands", () => {
    renderListing({ brands: [] });
    expect(within(sidebar()).queryByRole("group", { name: "Brand" })).not.toBeInTheDocument();
    expect(within(sidebar()).getByRole("group", { name: "Availability" })).toBeInTheDocument();
  });

  it("clears every filter but keeps the sort", async () => {
    setNavigation({ pathname: "/products" });
    renderListing({
      state: { ...base, sort: "rating", brands: ["Velo"], min: 10, max: 90, inStock: true },
    });
    await userEvent
      .setup()
      .click(within(sidebar()).getByRole("button", { name: "Clear all filters" }));
    expect(router.push).toHaveBeenCalledWith("/products?sort=rating", { scroll: false });
  });

  it("offers no Clear button without active filters", () => {
    renderListing();
    expect(
      within(sidebar()).queryByRole("button", { name: "Clear all filters" }),
    ).not.toBeInTheDocument();
  });

  it("opens the phone filter sheet with a count and closes it once applied", async () => {
    setNavigation({ pathname: "/products" });
    renderListing({ state: { ...base, brands: ["Velo"], inStock: true } });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Filters (2)" }));
    const sheet = await screen.findByRole("dialog", { name: "Filters" });
    await user.click(within(sheet).getByRole("checkbox", { name: "In stock only" }));
    expect(router.push).toHaveBeenCalledWith("/products?brand=Velo", { scroll: false });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("labels the phone trigger without a count when nothing is filtered", () => {
    renderListing();
    expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument();
  });
});
