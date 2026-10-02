import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { summary } from "@/test/fixtures/insights";

import { StatTiles } from "./stat-tiles";

/** The tile whose term is `label`: its <dt> and <dd> share a wrapper. */
function tile(label: string): HTMLElement {
  const dt = screen.getAllByRole("term").find((element) => element.textContent === label);
  if (!dt?.parentElement) throw new Error(`No tile labelled ${label}`);
  return dt.parentElement;
}

describe("StatTiles", () => {
  it("shows each headline figure against the previous period", () => {
    render(<StatTiles summary={summary()} period="30 days" />);

    expect(tile("Revenue")).toHaveTextContent("$4,800.00");
    expect(tile("Revenue")).toHaveTextContent("Up 20% vs previous 30 days");

    expect(tile("Orders")).toHaveTextContent("40");
    expect(tile("Orders")).toHaveTextContent("Down 20% vs previous 30 days");

    // 400000 / 50 = 8000 before, 12000 now.
    expect(tile("Average order value")).toHaveTextContent("$120.00");
    expect(tile("Average order value")).toHaveTextContent("Up 50% vs previous 30 days");

    expect(tile("Refunded")).toHaveTextContent("$25.00");
    expect(tile("Refunded")).toHaveTextContent("This period only, no comparison");

    expect(tile("New customers")).toHaveTextContent("12");
    expect(tile("New customers")).toHaveTextContent("Accounts created, no comparison");
  });

  it("carries direction in words and colour follows whether the move is good", () => {
    render(<StatTiles summary={summary()} period="7 days" />);
    const up = screen.getAllByText("Up")[0]?.closest("p");
    const down = screen.getByText("Down").closest("p");
    expect(up).toHaveClass("text-success");
    expect(down).toHaveClass("text-danger");
  });

  it("says when there is nothing to compare with", () => {
    render(
      <StatTiles
        summary={summary({ revenue: 10_000, previous_revenue: 0, orders: 2, previous_orders: 0 })}
        period="30 days"
      />,
    );
    expect(tile("Revenue")).toHaveTextContent("none in the previous period vs previous 30 days");
    expect(tile("Revenue")).not.toHaveTextContent("Up");
    expect(tile("Average order value")).toHaveTextContent("No orders in the previous period");
  });

  it("reads 'no change' for a flat or negligible move", () => {
    render(
      <StatTiles
        summary={summary({
          revenue: 0,
          previous_revenue: 0,
          orders: 100_000,
          previous_orders: 100_001,
          average_order_value: 4,
        })}
        period="30 days"
      />,
    );
    expect(tile("Revenue")).toHaveTextContent("no change vs previous 30 days");
    expect(tile("Orders")).toHaveTextContent("no change vs previous 30 days");
    expect(screen.getAllByText("no change")[0]?.closest("p")).toHaveClass("text-text-secondary");
  });

  it("shows a dash for average order value before the first order", () => {
    render(
      <StatTiles
        summary={summary({ orders: 0, revenue: 0, average_order_value: 0, previous_orders: 3 })}
        period="30 days"
      />,
    );
    expect(tile("Average order value")).toHaveTextContent("—");
    expect(tile("Average order value")).toHaveTextContent("No orders yet");
  });

  it("formats money in the store currency", () => {
    render(
      <StatTiles
        summary={summary({ currency: "JPY", revenue: 5_000, refunded: 0 })}
        period="7 days"
      />,
    );
    expect(tile("Revenue")).toHaveTextContent("¥5,000");
    expect(tile("Refunded")).toHaveTextContent("¥0");
  });
});
