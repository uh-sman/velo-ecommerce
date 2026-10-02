import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PriceDisplay, RatingStars } from "@/components/commerce/price";
import { usd } from "@/test/fixtures/commerce";

describe("PriceDisplay", () => {
  it("shows a plain price without a sale or range", () => {
    const { container } = render(<PriceDisplay price={usd(4500)} />);
    expect(container).toHaveTextContent("$45.00");
    expect(container.querySelector("s")).toBeNull();
    expect(container).not.toHaveTextContent("From");
  });

  it("strikes through the compare-at price and states the saving as text", () => {
    const { container } = render(
      <PriceDisplay price={usd(3000)} compareAt={usd(4000)} size="lg" />,
    );
    const was = container.querySelector("s");
    expect(was).toHaveTextContent("Was $40.00");
    expect(container).toHaveTextContent("−25%");
    expect(container.firstChild).toHaveClass("text-2xl");
  });

  it("ignores a compare-at that is not higher than the price", () => {
    const { container } = render(<PriceDisplay price={usd(3000)} compareAt={usd(3000)} />);
    expect(container.querySelector("s")).toBeNull();
    expect(container).not.toHaveTextContent("%");
  });

  it("prefixes 'From' when the variants span a price range", () => {
    const { container } = render(
      <PriceDisplay price={usd(3000)} priceMax={usd(5000)} size="sm" className="extra" />,
    );
    expect(container).toHaveTextContent("From $30.00");
    expect(container.firstChild).toHaveClass("text-sm", "extra");
  });
});

describe("RatingStars", () => {
  it("describes the rating and review count to screen readers", () => {
    render(<RatingStars average={4.26} count={12} />);
    expect(screen.getByText("Rated 4.3 out of 5 from 12 reviews")).toBeInTheDocument();
    expect(screen.getByText("(12)")).toHaveAttribute("aria-hidden", "true");
  });

  it("fills stars to the nearest half and omits a missing count", () => {
    const { container } = render(<RatingStars average={3.4} />);
    expect(screen.getByText("Rated 3.4 out of 5")).toBeInTheDocument();
    expect(container).not.toHaveTextContent("(");
    const filled = container.querySelectorAll("svg.fill-warning");
    expect(filled).toHaveLength(3);
  });
});
