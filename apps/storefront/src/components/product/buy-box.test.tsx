import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { CART_CHANGED, OPEN_CART } from "@/components/commerce/cart-events";
import { WishlistProvider } from "@/components/commerce/wishlist-context";
import { ProductBuy } from "@/components/product/buy-box";
import { cart, installScrollTo, media, product, usd, variant } from "@/test/fixtures/commerce";
import { router, setNavigation } from "@/test/navigation";
import { fail, on, server } from "@/test/server";

beforeAll(installScrollTo);

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Two colours by two sizes; Black/L is sold out, Red/L is low. */
const tee = () =>
  product({
    brand: "Velo",
    subtitle: "Merino blend",
    rating: { average: 4.5, count: 8 },
    media: [
      media({ id: "m-1", alt_text: "Black tee" }),
      media({ id: "m-2", alt_text: "Red tee", variant_id: "red-m" }),
    ],
    options: [
      {
        name: "Color",
        values: [
          { value: "Black", swatch_hex: "#000000" },
          { value: "Red", swatch_hex: "#ff0000" },
        ],
      },
      { name: "Size", values: [{ value: "M" }, { value: "L" }] },
    ],
    variants: [
      variant({ id: "black-m", option_values: { Color: "Black", Size: "M" } }),
      variant({
        id: "black-l",
        option_values: { Color: "Black", Size: "L" },
        availability: { in_stock: false, quantity_available: 0 },
      }),
      variant({
        id: "red-m",
        option_values: { Color: "Red", Size: "M" },
        price: usd(3500),
        compare_at: usd(5000),
      }),
      variant({
        id: "red-l",
        option_values: { Color: "Red", Size: "L" },
        availability: { in_stock: true, quantity_available: 3 },
      }),
    ],
  });

const soldOut = () =>
  product({
    variants: [variant({ availability: { in_stock: false, quantity_available: 0 } })],
  });

const addButton = () => screen.getByRole("button", { name: "Add to cart" });

describe("ProductBuy", () => {
  it("shows the product heading, brand, subtitle, rating and price", () => {
    render(<ProductBuy product={tee()} />);
    expect(screen.getByRole("heading", { level: 1, name: "Trail Tee" })).toBeInTheDocument();
    expect(screen.getByText("Velo")).toBeInTheDocument();
    expect(screen.getByText("Merino blend")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Rated 4.5 out of 5/ })).toHaveAttribute(
      "href",
      "#reviews",
    );
    expect(screen.getByText("$45.00")).toBeInTheDocument();
    expect(screen.getByText("In stock")).toBeInTheDocument();
    expect(addButton()).toBeEnabled();
  });

  it("starts on the first in-stock variant and marks options no in-stock variant has", async () => {
    render(<ProductBuy product={tee()} />);
    const size = screen.getByRole("group", { name: "Size: M" });
    const large = within(size).getByRole("button", { name: "L — out of stock" });
    expect(large).toHaveAttribute("aria-disabled", "true");
    expect(within(size).getByRole("button", { name: "M" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.setup().click(large);
    expect(screen.getByRole("group", { name: "Size: M" })).toBeInTheDocument();
  });

  it("switches variant, its price, stock message and gallery image", async () => {
    render(<ProductBuy product={tee()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Red" }));
    expect(screen.getByRole("group", { name: "Color: Red" })).toBeInTheDocument();
    expect(screen.getByText("$35.00")).toBeInTheDocument();
    expect(screen.getByText("−30%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show image 2" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "L" }));
    expect(screen.getByText("Only 3 left")).toBeInTheDocument();
  });

  it("starts on the first variant when everything is sold out, and offers a back-in-stock alert", () => {
    render(<ProductBuy product={soldOut()} />);
    expect(screen.getByRole("button", { name: "Out of stock" })).toBeDisabled();
    expect(screen.getByText("Out of stock", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText("Email me when it is back in stock")).toBeInTheDocument();
  });

  it("says when no variant exists", () => {
    render(<ProductBuy product={product({ variants: [], options: [] })} />);
    expect(screen.getByText("That combination is not made.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Out of stock" })).toBeDisabled();
    expect(screen.queryByText("Email me when it is back in stock")).not.toBeInTheDocument();
  });

  it("adds the chosen quantity optimistically, opens the cart, then resets", async () => {
    const changed = vi.fn();
    const opened = vi.fn();
    window.addEventListener(CART_CHANGED, changed);
    window.addEventListener(OPEN_CART, opened);
    let sent: unknown;
    server.use(
      on("post", "/api/v1/cart/items", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(cart());
      }),
    );
    render(<ProductBuy product={tee()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Increase quantity of Trail Tee" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Decrease quantity of Trail Tee" })).toBeEnabled();
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
    await user.click(addButton());
    expect(screen.getByRole("button", { name: "Added" })).toBeDisabled();
    await waitFor(() => {
      expect(opened).toHaveBeenCalled();
    });
    window.removeEventListener(CART_CHANGED, changed);
    window.removeEventListener(OPEN_CART, opened);
    expect(changed).toHaveBeenCalled();
    expect(sent).toEqual({ variant_id: "black-m", quantity: 2 });
    await waitFor(
      () => {
        expect(addButton()).toBeEnabled();
      },
      { timeout: 3000 },
    );
  });

  it("rolls back and explains a refused add", async () => {
    server.use(
      fail("post", "/api/v1/cart/items", {
        status: 422,
        errors: [{ field: "quantity", code: "insufficient_stock", message: "Only 1 left" }],
      }),
    );
    render(<ProductBuy product={tee()} />);
    await userEvent.setup().click(addButton());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Not added to your cart");
    expect(alert).toHaveTextContent("Only 1 left");
    expect(addButton()).toBeEnabled();
  });

  it.each([
    [{ status: 409, title: "Conflict", detail: "Cart is locked." }, "Cart is locked."],
    [{ status: 503, title: "Service unavailable" }, "Service unavailable"],
  ])("falls back to the problem detail, then title (%#)", async (problem, message) => {
    server.use(fail("post", "/api/v1/cart/items", problem));
    render(<ProductBuy product={tee()} />);
    await userEvent.setup().click(addButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("toggles the wishlist, sending a guest to sign in", async () => {
    setNavigation({ pathname: "/products/trail-tee" });
    render(
      <WishlistProvider signedIn={false}>
        <ProductBuy product={tee()} />
      </WishlistProvider>,
    );
    const heart = screen.getByRole("button", { name: "Save to wishlist" });
    expect(heart).toHaveAttribute("aria-pressed", "false");
    await userEvent.setup().click(heart);
    expect(router.push).toHaveBeenCalledWith("/sign-in?next=%2Fproducts%2Ftrail-tee");
  });

  it("shows a saved product's heart as pressed", async () => {
    server.use(on("get", "/api/v1/account/wishlist", () => HttpResponse.json([{ id: "prod-1" }])));
    render(
      <WishlistProvider signedIn>
        <ProductBuy product={tee()} />
      </WishlistProvider>,
    );
    expect(await screen.findByRole("button", { name: "Remove from wishlist" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("keeps a sticky Add to cart once the inline one scrolls away", () => {
    let report: ((entries: { isIntersecting: boolean }[]) => void) | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
          report = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    const view = render(<ProductBuy product={tee()} />);
    expect(screen.getAllByRole("button", { name: "Add to cart" })).toHaveLength(1);
    act(() => {
      report?.([{ isIntersecting: false }]);
    });
    expect(screen.getAllByRole("button", { name: "Add to cart" })).toHaveLength(2);
    act(() => {
      report?.([]);
    });
    expect(screen.getAllByRole("button", { name: "Add to cart" })).toHaveLength(1);
    view.unmount();
    expect(disconnect).toHaveBeenCalled();
  });
});

describe("Back-in-stock alert", () => {
  it("signs up an email for the sold-out variant", async () => {
    let sent: unknown;
    server.use(
      on("post", "/api/v1/products/{slug}/back-in-stock", async ({ request, params }) => {
        sent = { slug: params["slug"], body: await request.json() };
        return HttpResponse.json({ status: "subscribed" }, { status: 202 });
      }),
    );
    render(<ProductBuy product={soldOut()} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.click(screen.getByRole("button", { name: "Notify me" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "We will email you when it is back",
    );
    expect(sent).toEqual({
      slug: "trail-tee",
      body: { variant_id: "var-1", email: "ada@example.com" },
    });
  });

  it("sends no email for a signed-in customer who leaves it blank", async () => {
    let sent: unknown;
    server.use(
      on("post", "/api/v1/products/{slug}/back-in-stock", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({ status: "subscribed" }, { status: 202 });
      }),
    );
    render(<ProductBuy product={soldOut()} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Notify me" }));
    await screen.findByRole("status");
    expect(sent).toEqual({ variant_id: "var-1", email: null });
  });

  it("shows the email error, or the problem title", async () => {
    server.use(
      fail("post", "/api/v1/products/{slug}/back-in-stock", {
        status: 422,
        errors: [{ field: "email", code: "invalid", message: "Enter a valid email." }],
      }),
    );
    render(<ProductBuy product={soldOut()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Notify me" }));
    expect(await screen.findByText("Enter a valid email.")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");

    server.use(
      fail("post", "/api/v1/products/{slug}/back-in-stock", {
        status: 429,
        title: "Too many requests",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Notify me" }));
    expect(await screen.findByText("Too many requests")).toBeInTheDocument();
  });
});
