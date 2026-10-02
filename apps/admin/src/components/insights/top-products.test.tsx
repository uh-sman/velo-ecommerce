import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { topProduct } from "@/test/fixtures/insights";

import { TopProducts } from "./top-products";

describe("TopProducts", () => {
  const products = [
    topProduct({ title: "Trail Runner", units: 1_250, revenue: 200_000 }),
    topProduct({
      product_id: "55555555-5555-4555-8555-555555555555",
      title: "Rain Shell",
      units: 3,
      revenue: 50_000,
    }),
    topProduct({ product_id: null, slug: null, title: "Old Sock", units: 1, revenue: 0 }),
  ];

  it("ranks products with units and revenue in the store currency", () => {
    render(<TopProducts products={products} currency="USD" />);
    const table = screen.getByRole("table", { name: "Top products by revenue" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent(/^1Trail Runner1,250\$2,000\.00$/);
    expect(rows[1]).toHaveTextContent(/^2Rain Shell3\$500\.00$/);
  });

  it("links live products and marks deleted ones", () => {
    render(<TopProducts products={products} currency="USD" />);
    expect(screen.getByRole("link", { name: "Trail Runner" })).toHaveAttribute(
      "href",
      "/products/11111111-1111-4111-8111-111111111111",
    );
    expect(screen.queryByRole("link", { name: /Old Sock/ })).not.toBeInTheDocument();
    expect(screen.getByText("(deleted)").parentElement).toHaveTextContent("Old Sock (deleted)");
  });

  it("sizes each bar against the top seller", () => {
    const { container } = render(<TopProducts products={products} currency="USD" />);
    const bars = Array.from(
      container.querySelectorAll<HTMLElement>("td div[aria-hidden] > div"),
      (bar) => bar.style.width,
    );
    // A zero row still keeps a 1% sliver once the top seller has revenue.
    expect(bars).toEqual(["100%", "25%", "1%"]);
  });

  it("draws no bars when nothing earned revenue", () => {
    const { container } = render(
      <TopProducts products={[topProduct({ revenue: 0 })]} currency="EUR" />,
    );
    expect(container.querySelector<HTMLElement>("td div[aria-hidden] > div")?.style.width).toBe(
      "0%",
    );
    expect(screen.getByRole("table")).toHaveTextContent("€0.00");
  });
});
