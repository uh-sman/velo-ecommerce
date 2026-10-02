import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useWishlist, WishlistProvider } from "@/components/commerce/wishlist-context";
import { productCard } from "@/test/fixtures/commerce";
import { router, setNavigation } from "@/test/navigation";
import { fail, ok, on, server } from "@/test/server";

afterEach(() => {
  vi.restoreAllMocks();
});

function Heart({ id, title }: { id: string; title: string }) {
  const wishlist = useWishlist();
  const saved = wishlist.has(id);
  return (
    <button type="button" aria-pressed={saved} onClick={() => void wishlist.toggle(id, title)}>
      {title}
    </button>
  );
}

function renderHearts(signedIn: boolean) {
  return render(
    <WishlistProvider signedIn={signedIn}>
      <Heart id="prod-1" title="Trail Tee" />
      <Heart id="prod-2" title="Ridge Jacket" />
    </WishlistProvider>,
  );
}

describe("useWishlist", () => {
  it("is inert outside a provider", async () => {
    render(<Heart id="prod-1" title="Trail Tee" />);
    const button = screen.getByRole("button", { name: "Trail Tee" });
    await userEvent.setup().click(button);
    expect(button).toHaveAttribute("aria-pressed", "false");
  });
});

describe("WishlistProvider", () => {
  it("loads the saved ids once for a signed-in customer", async () => {
    server.use(ok("get", "/api/v1/account/wishlist", [productCard({ id: "prod-2" })]));
    renderHearts(true);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Ridge Jacket" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    expect(screen.getByRole("button", { name: "Trail Tee" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("stays empty if the wishlist cannot be loaded", async () => {
    let asked = false;
    server.use(
      on("get", "/api/v1/account/wishlist", () => {
        asked = true;
        return HttpResponse.json({ type: "x", title: "Down", status: 503 }, { status: 503 });
      }),
    );
    renderHearts(true);
    await waitFor(() => {
      expect(asked).toBe(true);
    });
    expect(screen.getByRole("button", { name: "Ridge Jacket" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("sends a guest to sign in and back", async () => {
    setNavigation({ pathname: "/products/trail-tee" });
    renderHearts(false);
    await userEvent.setup().click(screen.getByRole("button", { name: "Trail Tee" }));
    expect(router.push).toHaveBeenCalledWith("/sign-in?next=%2Fproducts%2Ftrail-tee");
  });

  it("saves optimistically and confirms", async () => {
    const success = vi.spyOn(toast, "success");
    let sent: unknown;
    server.use(
      ok("get", "/api/v1/account/wishlist", []),
      on("post", "/api/v1/account/wishlist", async ({ request }) => {
        sent = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderHearts(true);
    const heart = screen.getByRole("button", { name: "Trail Tee" });
    await userEvent.setup().click(heart);
    expect(heart).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => {
      expect(success).toHaveBeenCalledWith("Saved Trail Tee", expect.anything());
    });
    expect(sent).toEqual({ product_id: "prod-1" });
  });

  it("removes a saved product and confirms", async () => {
    const success = vi.spyOn(toast, "success");
    server.use(
      ok("get", "/api/v1/account/wishlist", [productCard({ id: "prod-1" })]),
      ok("delete", "/api/v1/account/wishlist/{product_id}", null, 204),
    );
    renderHearts(true);
    const heart = screen.getByRole("button", { name: "Trail Tee" });
    await waitFor(() => {
      expect(heart).toHaveAttribute("aria-pressed", "true");
    });
    await userEvent.setup().click(heart);
    expect(heart).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => {
      expect(success).toHaveBeenCalledWith("Removed Trail Tee", expect.anything());
    });
  });

  it("rolls back a save the server refuses", async () => {
    const error = vi.spyOn(toast, "error");
    server.use(
      ok("get", "/api/v1/account/wishlist", []),
      fail("post", "/api/v1/account/wishlist", { status: 500 }),
    );
    renderHearts(true);
    const heart = screen.getByRole("button", { name: "Trail Tee" });
    await userEvent.setup().click(heart);
    await waitFor(() => {
      expect(error).toHaveBeenCalledWith(
        "We could not update your wishlist. Please try again.",
        expect.anything(),
      );
    });
    expect(heart).toHaveAttribute("aria-pressed", "false");
  });

  it("rolls back a removal the server refuses", async () => {
    const error = vi.spyOn(toast, "error");
    server.use(
      ok("get", "/api/v1/account/wishlist", [productCard({ id: "prod-1" })]),
      fail("delete", "/api/v1/account/wishlist/{product_id}", { status: 500 }),
    );
    renderHearts(true);
    const heart = screen.getByRole("button", { name: "Trail Tee" });
    await waitFor(() => {
      expect(heart).toHaveAttribute("aria-pressed", "true");
    });
    await userEvent.setup().click(heart);
    await waitFor(() => {
      expect(error).toHaveBeenCalled();
    });
    expect(heart).toHaveAttribute("aria-pressed", "true");
  });

  it("forgets saved ids on sign-out", async () => {
    server.use(ok("get", "/api/v1/account/wishlist", [productCard({ id: "prod-1" })]));
    const view = renderHearts(true);
    const heart = screen.getByRole("button", { name: "Trail Tee" });
    await waitFor(() => {
      expect(heart).toHaveAttribute("aria-pressed", "true");
    });
    view.rerender(
      <WishlistProvider signedIn={false}>
        <Heart id="prod-1" title="Trail Tee" />
      </WishlistProvider>,
    );
    expect(screen.getByRole("button", { name: "Trail Tee" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});
