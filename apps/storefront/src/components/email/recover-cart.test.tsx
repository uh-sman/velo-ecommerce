import { render, screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { RecoverCart } from "@/components/email/recover-cart";
import { router, setNavigation } from "@/test/navigation";
import { fail, on, server } from "@/test/server";

describe("RecoverCart", () => {
  it("restores the cart from the token, then shows it", async () => {
    const sent: unknown[] = [];
    server.use(
      on("post", "/api/v1/cart/recover", async ({ request }) => {
        sent.push(await request.json());
        return HttpResponse.json({});
      }),
    );
    setNavigation({ pathname: "/cart/recover", search: { token: "cart-tok" } });
    render(<RecoverCart />);
    expect(screen.getByRole("status")).toHaveTextContent("Restoring your cart…");
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith("/cart");
    });
    expect(router.refresh).toHaveBeenCalled();
    expect(sent).toEqual([{ token: "cart-tok" }]);
  });

  it("explains an incomplete link without calling the API", () => {
    render(<RecoverCart />);
    expect(screen.getByRole("alert")).toHaveTextContent("This link is incomplete");
    expect(screen.getByRole("link", { name: "Keep shopping" })).toHaveAttribute(
      "href",
      "/products",
    );
  });

  it("asks the owner to sign in for an account's cart", async () => {
    server.use(fail("post", "/api/v1/cart/recover", { status: 409, slug: "cart-owned" }));
    setNavigation({ search: { token: "owned" } });
    render(<RecoverCart />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This cart belongs to an account — sign in to see it.",
    );
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/sign-in?next=/cart",
    );
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("explains a cart that is gone", async () => {
    server.use(fail("post", "/api/v1/cart/recover", { status: 404, slug: "not-found" }));
    setNavigation({ search: { token: "gone" } });
    render(<RecoverCart />);
    expect(await screen.findByRole("alert")).toHaveTextContent("This cart is no longer available.");
    expect(screen.getByRole("link", { name: "Keep shopping" })).toBeInTheDocument();
  });
});
