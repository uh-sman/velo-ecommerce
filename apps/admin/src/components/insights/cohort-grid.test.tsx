import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { cohort } from "@/test/fixtures/insights";

import { CohortGrid } from "./cohort-grid";

function row(month: string): HTMLElement {
  const header = screen.getByRole("rowheader", { name: month });
  const tr = header.closest("tr");
  if (!tr) throw new Error(`No row for ${month}`);
  return tr;
}

describe("CohortGrid", () => {
  const cohorts = [
    cohort("2026-07-01", 40, [0.25, 0.1, 0]),
    cohort("2026-08-01", 1_200, [0.5]),
    cohort("2026-09-01", 0, []),
  ];

  it("is a captioned table with one column per month offset", () => {
    render(<CohortGrid cohorts={cohorts} />);
    const table = screen.getByRole("table", {
      name: /Share of each month's new customers who ordered again/,
    });
    const headers = within(table).getAllByRole("columnheader");
    expect(headers.map((header) => header.textContent)).toEqual([
      "First order",
      "Customers",
      "M1Month 1",
      "M2Month 2",
      "M3Month 3",
    ]);
  });

  it("prints each cohort's size and retention, with zero distinct from not yet", () => {
    render(<CohortGrid cohorts={cohorts} />);
    const july = within(row("Jul 2026")).getAllByRole("cell");
    expect(july.map((cell) => cell.textContent)).toEqual(["40", "25%", "10%", "0%"]);
    expect(july[1]).toHaveAttribute("title", "Jul 2026 cohort, month 1: 25%");

    const august = within(row("Aug 2026")).getAllByRole("cell");
    expect(august.map((cell) => cell.textContent)).toEqual(["1,200", "50%", "Not yet", "Not yet"]);
  });

  it("shows a dash for a cohort without customers, untinted", () => {
    render(<CohortGrid cohorts={[cohort("2026-09-01", 0, [0])]} />);
    const cells = within(row("Sep 2026")).getAllByRole("cell");
    expect(cells[1]).toHaveTextContent("—");
    expect(cells[1]?.style.backgroundColor).toBe("");
  });

  it("tints cells by share of the largest value, leaving zero untinted", () => {
    render(<CohortGrid cohorts={cohorts} />);
    const july = within(row("Jul 2026")).getAllByRole("cell");
    const august = within(row("Aug 2026")).getAllByRole("cell");
    // 0.5 is the largest value: full strength (8 + 42 = 50%).
    expect(august[1]?.getAttribute("style")).toContain("50%");
    // 0.25 of 0.5: 8 + 21 = 29%.
    expect(july[1]?.getAttribute("style")).toContain("29%");
    expect(july[3]?.getAttribute("style")).toBeNull();
  });

  it("explains the legend with the largest share", () => {
    render(<CohortGrid cohorts={cohorts} />);
    expect(screen.getByText(/Darker means a larger share, up to 50%/)).toBeInTheDocument();
  });

  it("renders an empty grid", () => {
    render(<CohortGrid cohorts={[]} />);
    expect(screen.queryAllByRole("row")).toHaveLength(1);
    expect(screen.getByText(/up to 0%/)).toBeInTheDocument();
  });
});
