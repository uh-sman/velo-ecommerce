import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { MobileNav } from "@/components/shell/mobile-nav";
import { aCategory } from "@/test/fixtures/account";
import { setNavigation } from "@/test/navigation";

const CATEGORIES = [
  aCategory("Shoes", [aCategory("Running"), aCategory("Hiking")]),
  aCategory("Bags"),
];

describe("MobileNav", () => {
  it("opens a drawer with the whole navigation", async () => {
    const user = userEvent.setup();
    render(<MobileNav categories={CATEGORIES} />);
    expect(screen.queryByRole("navigation", { name: "Main" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open menu" }));
    const drawer = await screen.findByRole("dialog", { name: "Menu" });
    const nav = within(drawer).getByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "New arrivals" })).toHaveAttribute(
      "href",
      "/products",
    );
    expect(within(nav).getByText("Shoes", { selector: "summary" })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "All Shoes" })).toHaveAttribute(
      "href",
      "/categories/shoes",
    );
    expect(within(nav).getByRole("link", { name: "Running" })).toHaveAttribute(
      "href",
      "/categories/running",
    );
    expect(within(nav).getByRole("link", { name: "All Bags" })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Collections" })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Your account" })).toHaveAttribute(
      "href",
      "/account",
    );
  });

  it("closes the drawer when the route changes", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<MobileNav categories={CATEGORIES} />);
    await user.click(screen.getByRole("button", { name: "Open menu" }));
    await screen.findByRole("dialog", { name: "Menu" });
    setNavigation({ pathname: "/categories/shoes" });
    rerender(<MobileNav categories={CATEGORIES} />);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});
