import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SiteHeader } from "@/components/site-header";
import { aCategory, aUser } from "@/test/fixtures/account";

// The header is a Server Component; its data comes from the server-only API module.
const api = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getCartCount: vi.fn(),
  getCategoryTree: vi.fn(),
}));
vi.mock("@/lib/api-server", () => api);

beforeEach(() => {
  api.getSessionUser.mockReset().mockResolvedValue(null);
  api.getCartCount.mockReset().mockResolvedValue(0);
  api.getCategoryTree.mockReset().mockResolvedValue([]);
});

describe("SiteHeader", () => {
  it("offers sign-in to a visitor, with search, cart, menu and theme", async () => {
    render(await SiteHeader());
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Velo" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/sign-in");
    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open menu" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cart, 0 items" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Colour theme" })).toBeInTheDocument();
    // No categories: no desktop mega-nav.
    expect(screen.queryByRole("navigation", { name: "Shop by category" })).not.toBeInTheDocument();
  });

  it("greets a signed-in customer by name and shows their cart count", async () => {
    api.getSessionUser.mockResolvedValue(aUser({ first_name: "Ada" }));
    api.getCartCount.mockResolvedValue(3);
    api.getCategoryTree.mockResolvedValue([aCategory("Shoes")]);
    render(await SiteHeader());
    expect(screen.getByRole("link", { name: "Ada" })).toHaveAttribute("href", "/account");
    expect(screen.getByRole("button", { name: "Cart, 3 items" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Shop by category" })).toBeInTheDocument();
  });

  it("falls back to “Account” for a customer without a first name", async () => {
    api.getSessionUser.mockResolvedValue(aUser({ first_name: null }));
    render(await SiteHeader());
    expect(screen.getByRole("link", { name: "Account" })).toHaveAttribute("href", "/account");
  });
});
