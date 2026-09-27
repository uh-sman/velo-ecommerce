import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Button } from "./button";

afterEach(cleanup);

describe("Button", () => {
  it("defaults to the primary variant at md size", () => {
    render(<Button>Pay</Button>);
    const button = screen.getByRole("button", { name: "Pay" });

    expect(button.dataset["variant"]).toBe("primary");
    expect(button.dataset["size"]).toBe("md");
    expect(button.className).toContain("h-10");
  });

  it("maps every size in the spec to its height", () => {
    const heights = { sm: "h-8", md: "h-10", lg: "h-12", xl: "h-14" } as const;
    for (const [size, height] of Object.entries(heights)) {
      render(<Button size={size as keyof typeof heights}>{size}</Button>);
      expect(screen.getByRole("button", { name: size }).className).toContain(height);
    }
  });

  it("extends sub-44px sizes to a 44px hit area", () => {
    render(<Button size="sm">Small</Button>);
    expect(screen.getByRole("button", { name: "Small" }).className).toContain("after:-inset-y-1.5");
  });

  describe("loading", () => {
    it("disables the button and marks it busy", () => {
      render(<Button loading>Place order</Button>);
      const button = screen.getByRole("button");

      expect(button).toHaveProperty("disabled", true);
      expect(button.getAttribute("aria-busy")).toBe("true");
    });

    it("keeps the label in the layout, hidden, so the width cannot change", () => {
      render(<Button loading>Place order</Button>);
      const label = screen.getByText("Place order");

      expect(label.className).toContain("invisible");
      expect(screen.getByText("Loading").className).toContain("sr-only");
    });

    it("is not busy when not loading", () => {
      render(<Button>Place order</Button>);
      const button = screen.getByRole("button", { name: "Place order" });

      expect(button.hasAttribute("aria-busy")).toBe(false);
      expect(button).toHaveProperty("disabled", false);
    });
  });

  it("renders its child element with asChild", () => {
    render(
      <Button asChild variant="link">
        <a href="/cart">Cart</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Cart" });

    expect(link.getAttribute("href")).toBe("/cart");
    expect(link.dataset["variant"]).toBe("link");
  });
});
