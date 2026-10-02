import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ChartSkeleton, ListSkeleton, TilesSkeleton } from "./skeletons";

describe("loading skeletons", () => {
  it("TilesSkeleton holds five tiles and announces itself as busy", () => {
    render(<TilesSkeleton />);
    const region = screen.getByLabelText("Loading figures");
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(region.childElementCount).toBe(5);
  });

  it("ChartSkeleton takes the chart's height and label", () => {
    render(
      <>
        <ChartSkeleton />
        <ChartSkeleton height={392} label="Loading revenue and orders" />
      </>,
    );
    expect(screen.getByLabelText("Loading chart")).toHaveStyle({ height: "200px" });
    const custom = screen.getByLabelText("Loading revenue and orders");
    expect(custom).toHaveStyle({ height: "392px" });
    expect(custom).toHaveAttribute("aria-busy", "true");
  });

  it("ListSkeleton draws the requested number of rows", () => {
    render(
      <>
        <ListSkeleton />
        <ListSkeleton rows={8} label="Loading top products" />
      </>,
    );
    expect(screen.getByLabelText("Loading").childElementCount).toBe(4);
    const custom = screen.getByLabelText("Loading top products");
    expect(custom.childElementCount).toBe(8);
    expect(custom).toHaveAttribute("aria-busy", "true");
  });
});
