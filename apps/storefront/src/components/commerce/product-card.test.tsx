import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CART_CHANGED, OPEN_CART } from "@/components/commerce/cart-events";
import { ProductCard, ProductGrid } from "@/components/commerce/product-card";
import { WishlistProvider } from "@/components/commerce/wishlist-context";
import { cart, product, productCard, usd, variant } from "@/test/fixtures/commerce";
import { router } from "@/test/navigation";
import { fail, ok, on, server } from "@/test/server";

afterEach(() => {
  vi.restoreAllMocks();
});

function listen(name: string) {
  const listener = vi.fn();
  window.addEventListener(name, listener);
  return {
    listener,
    stop: () => {
      window.removeEventListener(name, listener);
    },
  };
}

describe("ProductCard", () => {
  it("links the title to the product page and shows price, brand and rating", () => {
    render(<ProductCard card={productCard({ compare_at: usd(6000) })} />);
    const heading = screen.getByRole("heading", { level: 3, name: "Trail Tee" });
    expect(within(heading).getByRole("link")).toHaveAttribute("href", "/products/trail-tee");
    expect(screen.getByText("Velo")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Front view" })).toBeInTheDocument();
    expect(screen.getByText("Rated 4.5 out of 5 from 12 reviews")).toBeInTheDocument();
    expect(screen.getByText("−25%")).toBeInTheDocument();
    expect(screen.queryByText("Sold out")).not.toBeInTheDocument();
  });

  it("marks a sold-out product and offers no quick add", () => {
    render(
      <ProductCard
        card={productCard({ in_stock: false, image: null, brand: null, rating: null })}
        headingLevel="h2"
      />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Trail Tee" })).toBeInTheDocument();
    expect(screen.getByText("Sold out")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Quick add/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByText(/Rated/)).not.toBeInTheDocument();
  });

  it("hides the rating when there are no reviews", () => {
    render(<ProductCard card={productCard({ rating: { average: 0, count: 0 } })} />);
    expect(screen.queryByText(/Rated/)).not.toBeInTheDocument();
  });

  it("quick-adds a product with one purchasable variant and opens the cart", async () => {
    const changed = listen(CART_CHANGED);
    const opened = listen(OPEN_CART);
    let sent: unknown;
    server.use(
      ok("get", "/api/v1/products/{slug}", product()),
      on("post", "/api/v1/cart/items", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(cart());
      }),
    );
    render(<ProductCard card={productCard()} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Quick add Trail Tee" }));
    await waitFor(() => {
      expect(opened.listener).toHaveBeenCalled();
    });
    changed.stop();
    opened.stop();
    expect(sent).toEqual({ variant_id: "var-1", quantity: 1 });
    expect((changed.listener.mock.calls[0]?.[0] as CustomEvent<number>).detail).toBe(1);
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Quick add Trail Tee" })).toBeEnabled();
  });

  it("goes to the product page when there is a choice to make", async () => {
    server.use(
      ok(
        "get",
        "/api/v1/products/{slug}",
        product({
          variants: [variant(), variant({ id: "var-2", option_values: { Size: "L" } })],
        }),
      ),
    );
    render(<ProductCard card={productCard()} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Quick add Trail Tee" }));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith("/products/trail-tee");
    });
  });

  it("goes to the product page when the product cannot be loaded", async () => {
    server.use(fail("get", "/api/v1/products/{slug}", { status: 404, slug: "not-found" }));
    render(<ProductCard card={productCard()} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Quick add Trail Tee" }));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith("/products/trail-tee");
    });
  });

  it("reports the field error when the add is refused", async () => {
    const error = vi.spyOn(toast, "error");
    server.use(
      ok("get", "/api/v1/products/{slug}", product()),
      fail("post", "/api/v1/cart/items", {
        status: 422,
        slug: "validation",
        title: "Invalid",
        errors: [{ field: "quantity", message: "Only 0 left", code: "insufficient_stock" }],
      }),
    );
    render(<ProductCard card={productCard()} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Quick add Trail Tee" }));
    await waitFor(() => {
      expect(error).toHaveBeenCalledWith("Only 0 left", expect.anything());
    });
  });

  it("falls back to the problem title when there is no field error", async () => {
    const error = vi.spyOn(toast, "error");
    server.use(
      ok("get", "/api/v1/products/{slug}", product()),
      fail("post", "/api/v1/cart/items", { status: 409, title: "Cart is locked" }),
    );
    render(<ProductCard card={productCard()} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Quick add Trail Tee" }));
    await waitFor(() => {
      expect(error).toHaveBeenCalledWith("Cart is locked", expect.anything());
    });
  });

  it("toggles the wishlist heart", async () => {
    server.use(
      ok("get", "/api/v1/account/wishlist", []),
      ok("post", "/api/v1/account/wishlist", null, 204),
    );
    render(
      <WishlistProvider signedIn>
        <ProductCard card={productCard()} />
      </WishlistProvider>,
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Save Trail Tee to wishlist" }));
    expect(screen.getByRole("button", { name: "Remove Trail Tee from wishlist" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

describe("ProductGrid", () => {
  it("lists every card", () => {
    render(
      <ProductGrid
        headingLevel="h2"
        cards={[productCard(), productCard({ id: "prod-2", slug: "ridge", title: "Ridge" })]}
      />,
    );
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(screen.getByRole("heading", { level: 2, name: "Ridge" })).toBeInTheDocument();
  });
});
