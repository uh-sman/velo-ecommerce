import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SiteFooter } from "@/components/shell/site-footer";
import { aCategory } from "@/test/fixtures/account";

// The footer is a Server Component; its data comes from the server-only API module.
const api = vi.hoisted(() => ({ getCategoryTree: vi.fn() }));
vi.mock("@/lib/api-server", () => api);

beforeEach(() => {
  api.getCategoryTree.mockReset();
});

describe("SiteFooter", () => {
  it("links up to five top categories alongside help and account pages", async () => {
    api.getCategoryTree.mockResolvedValue(
      ["Shoes", "Bags", "Hats", "Socks", "Coats", "Gloves"].map((name) => aCategory(name)),
    );
    render(await SiteFooter());
    const shop = screen.getByRole("navigation", { name: "Shop" });
    expect(
      within(shop)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["New arrivals", "Shoes", "Bags", "Hats", "Socks", "Coats", "Collections"]);
    expect(within(shop).getByRole("link", { name: "Shoes" })).toHaveAttribute(
      "href",
      "/categories/shoes",
    );
    const help = screen.getByRole("navigation", { name: "Help" });
    expect(within(help).getByRole("link", { name: "Track an order" })).toHaveAttribute(
      "href",
      "/orders/lookup",
    );
    expect(within(help).getByRole("link", { name: "support@velo.dev" })).toHaveAttribute(
      "href",
      "mailto:support@velo.dev",
    );
    expect(
      within(screen.getByRole("navigation", { name: "Account" })).getAllByRole("link"),
    ).toHaveLength(3);
    expect(screen.getByRole("contentinfo")).toHaveTextContent(
      `© ${String(new Date().getFullYear())} Velo.`,
    );
  });

  it("still renders when the category tree is empty", async () => {
    api.getCategoryTree.mockResolvedValue([]);
    render(await SiteFooter());
    expect(
      within(screen.getByRole("navigation", { name: "Shop" })).getAllByRole("link"),
    ).toHaveLength(2);
  });
});
