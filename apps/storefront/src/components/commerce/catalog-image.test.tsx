import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { media } from "@/test/fixtures/commerce";

import { CatalogImage } from "./catalog-image";

const renditions = [640, 320].flatMap((width) =>
  ["avif", "webp"].map((format) => ({
    format,
    width,
    height: width * 1.25,
    url: `https://cdn.example/m-1/${width}.${format}`,
  })),
);

describe("CatalogImage", () => {
  it("offers AVIF then WebP at every width, narrowest first", () => {
    const { container } = render(
      <CatalogImage media={media({ renditions })} alt="Front view" sizes="50vw" />,
    );
    const sources = container.querySelectorAll("source");
    expect([...sources].map((s) => s.getAttribute("type"))).toEqual(["image/avif", "image/webp"]);
    expect(sources[0]?.getAttribute("srcset")).toBe(
      "https://cdn.example/m-1/320.avif 320w, https://cdn.example/m-1/640.avif 640w",
    );
    expect(sources[1]?.getAttribute("sizes")).toBe("50vw");
  });

  it("declares its size and loads lazily below the fold", () => {
    render(<CatalogImage media={media()} alt="Front view" sizes="50vw" />);
    const image = screen.getByRole("img", { name: "Front view" });
    expect(image).toHaveAttribute("src", "https://cdn.example/m-1.jpg");
    expect(image).toHaveAttribute("width", "800");
    expect(image).toHaveAttribute("height", "1000");
    expect(image).toHaveAttribute("loading", "lazy");
    expect(image).toHaveAttribute("decoding", "async");
  });

  it("fetches the LCP image eagerly and first", () => {
    render(<CatalogImage media={media()} alt="Front view" sizes="100vw" priority />);
    const image = screen.getByRole("img", { name: "Front view" });
    expect(image).toHaveAttribute("loading", "eager");
    expect(image).toHaveAttribute("fetchpriority", "high");
  });

  it("paints the blurhash underneath until the image arrives, in the server HTML", () => {
    // Asserted on the server render: that is where it matters (first paint), and
    // jsdom's CSS parser drops data-URL backgrounds.
    const html = renderToStaticMarkup(
      <CatalogImage
        media={media({ blurhash: "L7M_9,]TfQ]T|^o1fQo1fQfQfQfQ" })}
        alt="Front view"
        sizes="50vw"
      />,
    );
    expect(html).toMatch(/style="background-image:url\(&quot;data:image\/svg\+xml,/);
  });

  it("falls back to the original alone when there are no renditions or dimensions", () => {
    const { container } = render(
      <CatalogImage media={media({ width: null, height: null })} alt="" sizes="40px" />,
    );
    expect(container.querySelectorAll("source")).toHaveLength(0);
    const image = container.querySelector("img");
    expect(image).not.toHaveAttribute("width");
    expect(image?.style.backgroundImage).toBe("");
  });
});
