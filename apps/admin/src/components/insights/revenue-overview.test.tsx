import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { point } from "@/test/fixtures/insights";

import { RevenueOverview } from "./revenue-overview";

const POINTS = [
  point("2026-09-01", 125_000, 3),
  point("2026-09-02", 0, 0),
  point("2026-09-03", 80_050, 1),
];

beforeEach(() => {
  // Give the charts a width so they draw (jsdom has no layout).
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 600,
    bottom: 200,
    width: 600,
    height: 200,
    toJSON: () => ({}),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RevenueOverview", () => {
  it("captions revenue with its total and labels the chart with the span", () => {
    render(<RevenueOverview points={POINTS} currency="USD" interval="day" />);
    expect(screen.getByText("Revenue per day · $2,050.50 in total")).toBeInTheDocument();
    expect(
      screen.getByRole("slider", {
        name: "Revenue per day, Sep 1, 2026 to Sep 3, 2026. Use the arrow keys to read each day.",
      }),
    ).toBeInTheDocument();
    // Orders are only drawn on the analytics page.
    expect(screen.getAllByRole("slider")).toHaveLength(1);
    expect(screen.queryByText(/Orders per day/)).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("adds an orders chart that shares the active bucket with revenue", async () => {
    const user = userEvent.setup();
    render(<RevenueOverview points={POINTS} currency="USD" interval="day" showOrders />);
    expect(screen.getByText("Orders per day · 4 in total")).toBeInTheDocument();
    const revenue = screen.getByRole("slider", { name: /^Revenue per day/ });
    const orders = screen.getByRole("slider", { name: /^Orders per day/ });

    await user.click(revenue);
    await user.keyboard("{ArrowRight}");
    expect(revenue).toHaveAttribute("aria-valuetext", "Sep 1, 2026: $1,250.00");
    expect(orders).toHaveAttribute("aria-valuenow", "0");
    expect(orders).toHaveAttribute("aria-valuetext", "Sep 1, 2026: 3 orders");

    await user.keyboard("{End}");
    expect(orders).toHaveAttribute("aria-valuetext", "Sep 3, 2026: 1 order");
  });

  it("formats the order axis compactly", () => {
    const { container } = render(
      <RevenueOverview
        points={[point("2026-09-01", 0, 4_800)]}
        currency="USD"
        interval="day"
        showOrders
      />,
    );
    const ticks = Array.from(container.querySelectorAll("text"), (text) => text.textContent);
    expect(ticks).toContain("6K");
    expect(ticks).toContain("$0");
  });

  it("has every figure in a table, one row per bucket", async () => {
    const user = userEvent.setup();
    render(<RevenueOverview points={POINTS} currency="USD" interval="day" />);
    await user.click(screen.getByText("View as table"));
    const table = screen.getByRole("table", { name: "Revenue and orders per day (UTC)" });
    const headers = within(table).getAllByRole("columnheader");
    expect(headers.map((header) => header.textContent)).toEqual(["Day", "Revenue", "Orders"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      "Sep 1, 2026$1,250.003",
      "Sep 2, 2026$0.000",
      "Sep 3, 2026$800.501",
    ]);
  });

  it.each([
    ["week", "Week of", "Week of Aug 31, 2026", "2026-08-31"],
    ["month", "Month", "September 2026", "2026-09-01"],
  ] as const)("names %s buckets in the table", (interval, heading, label, period) => {
    render(
      <RevenueOverview points={[point(period, 1_000, 1)]} currency="EUR" interval={interval} />,
    );
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader")[0]).toHaveTextContent(heading);
    expect(within(table).getByRole("rowheader")).toHaveTextContent(label);
    expect(table).toHaveTextContent("€10.00");
  });

  it("says when nothing sold, still drawing every bucket at zero", () => {
    render(
      <RevenueOverview
        points={[point("2026-09-01", 0, 0), point("2026-09-02", 0, 0)]}
        currency="USD"
        interval="day"
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "No sales in this period. Every day is drawn at zero.",
    );
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });

  it("copes with an empty series", () => {
    render(<RevenueOverview points={[]} currency="USD" interval="week" />);
    expect(screen.getByRole("slider")).toHaveAttribute("aria-valuemax", "0");
    expect(screen.queryByRole("status")).toHaveTextContent("No sales in this period");
    expect(screen.getByText("Revenue per week · $0.00 in total")).toBeInTheDocument();
  });
});
