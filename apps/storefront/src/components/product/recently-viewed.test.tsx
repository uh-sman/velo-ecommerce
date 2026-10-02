import { render, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { RecentlyViewed } from "@/components/product/recently-viewed";
import { RECENTLY_VIEWED } from "@/lib/recent";
import { media, product, productCard, usd, variant } from "@/test/fixtures/commerce";
import { on, server } from "@/test/server";

const current = productCard({ id: "prod-now", slug: "now", title: "Now" });

function stored(): unknown {
  return JSON.parse(localStorage.getItem(RECENTLY_VIEWED) ?? "null");
}

describe("RecentlyViewed", () => {
  it("records the first product viewed and shows nothing", () => {
    const { container } = render(<RecentlyViewed current={current} />);
    expect(container).toBeEmptyDOMElement();
    expect(stored()).toEqual(["now"]);
  });

  it("shows up to four earlier products as cards, skipping any that fail", async () => {
    localStorage.setItem(
      RECENTLY_VIEWED,
      JSON.stringify(["now", "tee", "gone", "bare", "cap", "sock", "older"]),
    );
    const asked: string[] = [];
    server.use(
      on("get", "/api/v1/products/{slug}", ({ params }) => {
        const slug = String(params["slug"]);
        asked.push(slug);
        if (slug === "gone") {
          return HttpResponse.json(
            { type: "https://velo.dev/errors/not-found", title: "Not found", status: 404 },
            { status: 404 },
          );
        }
        if (slug === "bare") return HttpResponse.json(product({ slug, variants: [] }));
        return HttpResponse.json(
          product({
            id: `id-${slug}`,
            slug,
            title: slug === "tee" ? "Trail Tee" : "Ridge Cap",
            media: slug === "tee" ? [media({ alt_text: "Tee photo" })] : [],
            variants: [
              variant({ id: `${slug}-a`, price: usd(3000) }),
              variant({ id: `${slug}-b`, price: usd(5000) }),
            ],
          }),
        );
      }),
    );
    render(<RecentlyViewed current={current} />);

    const section = await screen.findByRole("region", { name: "Recently viewed" });
    const cards = within(section).getAllByRole("article");
    expect(cards).toHaveLength(2);
    expect(within(section).getByRole("link", { name: "Trail Tee" })).toHaveAttribute(
      "href",
      "/products/tee",
    );
    expect(within(section).getByRole("img", { name: "Tee photo" })).toBeInTheDocument();
    expect(cards[0]).toHaveTextContent("From $30.00");
    expect(asked.sort()).toEqual(["bare", "cap", "gone", "tee"]);
    await waitFor(() => {
      expect(stored()).toEqual(["now", "tee", "gone", "bare", "cap", "sock", "older"]);
    });
  });

  it("moves the current product to the front and shows nothing if every lookup fails", async () => {
    localStorage.setItem(RECENTLY_VIEWED, JSON.stringify(["a", "now"]));
    let asked = false;
    server.use(
      on("get", "/api/v1/products/{slug}", () => {
        asked = true;
        return HttpResponse.json(
          { type: "https://velo.dev/errors/not-found", title: "Not found", status: 404 },
          { status: 404 },
        );
      }),
    );
    const { container } = render(<RecentlyViewed current={current} />);
    expect(stored()).toEqual(["now", "a"]);
    await waitFor(() => {
      expect(asked).toBe(true);
    });
    expect(container).toBeEmptyDOMElement();
  });
});
