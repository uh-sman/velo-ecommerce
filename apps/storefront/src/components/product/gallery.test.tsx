import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { Gallery } from "@/components/product/gallery";
import { installScrollTo, media } from "@/test/fixtures/commerce";

const pictures = [
  media({ id: "m-1", url: "https://cdn.example/1.jpg", alt_text: "Front view" }),
  media({ id: "m-2", url: "https://cdn.example/2.jpg", alt_text: null }),
  media({ id: "m-3", url: "https://cdn.example/3.jpg", alt_text: "Back view" }),
];

beforeAll(installScrollTo);

const thumb = (n: number) => screen.getByRole("button", { name: `Show image ${String(n)}` });

describe("Gallery", () => {
  it("renders a placeholder without media", () => {
    const { container } = render(<Gallery media={[]} title="Trail Tee" />);
    expect(container.firstChild).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("labels the carousel and its slides, falling back to the title for alt text", () => {
    render(<Gallery media={pictures} title="Trail Tee" />);
    const carousel = screen.getByLabelText("Trail Tee images");
    expect(carousel).toHaveAttribute("aria-roledescription", "carousel");
    expect(within(carousel).getByLabelText("Image 2 of 3")).toBeInTheDocument();
    expect(within(carousel).getByRole("img", { name: "Front view" })).toBeInTheDocument();
    expect(within(carousel).getByRole("img", { name: "Trail Tee" })).toBeInTheDocument();
    expect(thumb(1)).toHaveAttribute("aria-current", "true");
  });

  it("shows no thumbnails for a single image", () => {
    render(<Gallery media={[pictures[0] ?? media()]} title="Trail Tee" />);
    expect(screen.queryByRole("list", { name: "Choose an image" })).not.toBeInTheDocument();
  });

  it("moves to a thumbnail's image and scrolls the strip there", async () => {
    const scrollTo = vi.spyOn(Element.prototype, "scrollTo");
    render(<Gallery media={pictures} title="Trail Tee" />);
    await userEvent.setup().click(thumb(3));
    expect(thumb(3)).toHaveAttribute("aria-current", "true");
    expect(thumb(1)).toHaveAttribute("aria-current", "false");
    expect(scrollTo).toHaveBeenCalledWith({ left: 0, behavior: "smooth" });
    scrollTo.mockRestore();
  });

  it("follows a swipe of the strip", () => {
    render(<Gallery media={pictures} title="Trail Tee" />);
    const strip = screen.getByLabelText("Trail Tee images");
    Object.defineProperty(strip, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(strip, "scrollLeft", { value: 410, configurable: true });
    fireEvent.scroll(strip);
    expect(thumb(2)).toHaveAttribute("aria-current", "true");
    // Scrolling within the same slide changes nothing.
    fireEvent.scroll(strip);
    expect(thumb(2)).toHaveAttribute("aria-current", "true");
  });

  it("moves to a chosen variant's image, and ignores an unknown one", () => {
    const view = render(<Gallery media={pictures} title="Trail Tee" focusMediaId="m-3" />);
    expect(thumb(3)).toHaveAttribute("aria-current", "true");
    view.rerender(<Gallery media={pictures} title="Trail Tee" focusMediaId="missing" />);
    expect(thumb(3)).toHaveAttribute("aria-current", "true");
  });

  it("opens the current image full size in a titled dialog", async () => {
    render(<Gallery media={pictures} title="Trail Tee" />);
    const user = userEvent.setup();
    await user.click(thumb(3));
    await user.click(screen.getByRole("button", { name: "Zoom image" }));
    const dialog = await screen.findByRole("dialog", { name: "Back view" });
    expect(within(dialog).getByRole("img", { name: "Back view" })).toHaveAttribute(
      "src",
      "https://cdn.example/3.jpg",
    );
  });

  it("titles the zoom dialog with the product when the image has no alt text", async () => {
    render(<Gallery media={pictures} title="Trail Tee" focusMediaId="m-2" />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Zoom image" }));
    expect(await screen.findByRole("dialog", { name: "Trail Tee" })).toBeInTheDocument();
  });
});
