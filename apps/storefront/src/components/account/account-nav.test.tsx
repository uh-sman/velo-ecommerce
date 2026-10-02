import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AccountNav } from "@/components/account/account-nav";
import { setNavigation } from "@/test/navigation";

function linkNamed(name: string) {
  return within(screen.getByRole("navigation", { name: "Account" })).getByRole("link", { name });
}

describe("AccountNav", () => {
  it("lists every account section with a sign-out button", () => {
    render(<AccountNav />);
    const nav = screen.getByRole("navigation", { name: "Account" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual([
      "Orders",
      "Returns",
      "Wishlist",
      "Details",
      "Addresses",
      "Email preferences",
      "Sessions",
    ]);
    expect(within(nav).getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("marks a section current for its nested pages", () => {
    setNavigation({ pathname: "/account/orders/VELO-1001" });
    render(<AccountNav />);
    expect(linkNamed("Orders")).toHaveAttribute("aria-current", "page");
    expect(linkNamed("Details")).not.toHaveAttribute("aria-current");
  });

  it("marks Details current only on /account itself", () => {
    setNavigation({ pathname: "/account" });
    render(<AccountNav />);
    expect(linkNamed("Details")).toHaveAttribute("aria-current", "page");
    expect(
      screen.getAllByRole("link").filter((link) => link.hasAttribute("aria-current")),
    ).toHaveLength(1);
  });
});
