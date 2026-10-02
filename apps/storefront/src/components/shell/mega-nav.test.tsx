import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { MegaNav } from "@/components/shell/mega-nav";
import { aCategory } from "@/test/fixtures/account";

const SHOES = aCategory("Shoes", [
  aCategory("Running", [
    aCategory("Trail"),
    aCategory("Road"),
    aCategory("Track"),
    aCategory("Cross"),
    aCategory("Ultra"),
    aCategory("Sprint"),
    aCategory("Seventh"),
  ]),
  aCategory("Hiking"),
]);

describe("MegaNav", () => {
  it("renders nothing without categories", () => {
    const { container } = render(<MegaNav categories={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("links leaf categories directly and caps the bar at six", () => {
    const categories = ["A", "B", "C", "D", "E", "F", "G"].map((name) => aCategory(name));
    render(<MegaNav categories={categories} />);
    const nav = screen.getByRole("navigation", { name: "Shop by category" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["A", "B", "C", "D", "E", "F", "Collections"]);
    expect(within(nav).getByRole("link", { name: "A" })).toHaveAttribute("href", "/categories/a");
    expect(within(nav).getByRole("link", { name: "Collections" })).toHaveAttribute(
      "href",
      "/collections",
    );
  });

  it("opens a panel of subcategories on click, not only on hover", async () => {
    const user = userEvent.setup();
    render(<MegaNav categories={[SHOES, aCategory("Bags")]} />);
    const trigger = screen.getByRole("button", { name: "Shoes" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "All Shoes" })).not.toBeInTheDocument();
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: "All Shoes" })).toHaveAttribute(
      "href",
      "/categories/shoes",
    );
    expect(screen.getByRole("link", { name: "Running" })).toHaveAttribute(
      "href",
      "/categories/running",
    );
    expect(screen.getByRole("link", { name: "Hiking" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Trail" })).toHaveAttribute(
      "href",
      "/categories/trail",
    );
    // At most six leaves per subcategory.
    expect(screen.getByRole("link", { name: "Sprint" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Seventh" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Bags" })).toBeInTheDocument();
  });
});
