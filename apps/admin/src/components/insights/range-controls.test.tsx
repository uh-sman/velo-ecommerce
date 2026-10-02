import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { router, setNavigation } from "@/test/navigation";

import { CohortMonthsControl, RangeControls } from "./range-controls";

const TODAY = "2026-10-02";

const LAST_30 = {
  preset: 30,
  from: "2026-09-03",
  to: "2026-10-02",
  interval: "day",
  months: 6,
} as const;

beforeEach(() => {
  setNavigation({ pathname: "/analytics" });
});

function group(name: string) {
  return screen.getByRole("group", { name });
}

describe("RangeControls", () => {
  it("marks the current preset and interval as pressed", () => {
    render(<RangeControls current={LAST_30} today={TODAY} />);
    const presets = within(group("Date range")).getAllByRole("button");
    expect(presets.map((button) => button.textContent)).toEqual([
      "7 days",
      "30 days",
      "90 days",
      "12 months",
    ]);
    expect(within(group("Date range")).getByRole("button", { name: "30 days" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(group("Date range")).getByRole("button", { name: "7 days" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(within(group("Interval")).getByRole("button", { name: "Day" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("From")).toHaveValue("2026-09-03");
    expect(screen.getByLabelText("To")).toHaveValue("2026-10-02");
    expect(screen.getByLabelText("To")).toHaveAttribute("max", TODAY);
  });

  it("navigates to a preset, keeping the interval and cohort months", async () => {
    const user = userEvent.setup();
    render(<RangeControls current={{ ...LAST_30, months: 12 }} today={TODAY} />);
    await user.click(screen.getByRole("button", { name: "90 days" }));
    expect(router.push).toHaveBeenCalledWith("/analytics?range=90&interval=day&months=12", {
      scroll: false,
    });
  });

  it("navigates to another interval", async () => {
    const user = userEvent.setup();
    render(<RangeControls current={LAST_30} today={TODAY} />);
    await user.click(screen.getByRole("button", { name: "Week" }));
    expect(router.push).toHaveBeenCalledWith("/analytics?range=30&interval=week", {
      scroll: false,
    });
  });

  it("applies a custom range", async () => {
    const user = userEvent.setup();
    render(<RangeControls current={LAST_30} today={TODAY} />);
    const from = screen.getByLabelText("From");
    const to = screen.getByLabelText("To");
    await user.clear(from);
    await user.type(from, "2026-08-01");
    await user.clear(to);
    await user.type(to, "2026-08-31");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(router.push).toHaveBeenCalledWith(
      "/analytics?range=custom&from=2026-08-01&to=2026-08-31&interval=day",
      { scroll: false },
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("asks for both dates", async () => {
    const user = userEvent.setup();
    render(<RangeControls current={LAST_30} today={TODAY} />);
    await user.clear(screen.getByLabelText("From"));
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Choose both dates.");
    expect(screen.getByLabelText("From")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("To")).toHaveAttribute("aria-invalid", "true");
    expect(router.push).not.toHaveBeenCalled();
  });

  it("refuses a start after the end, and clears the error once fixed", async () => {
    const user = userEvent.setup();
    render(<RangeControls current={LAST_30} today={TODAY} />);
    const from = screen.getByLabelText("From");
    await user.clear(from);
    await user.type(from, "2026-10-01");
    await user.clear(screen.getByLabelText("To"));
    await user.type(screen.getByLabelText("To"), "2026-09-01");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The start date must be on or before the end date.",
    );
    expect(router.push).not.toHaveBeenCalled();

    await user.clear(from);
    await user.type(from, "2026-08-15");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("From")).toHaveAttribute("aria-invalid", "false");
    expect(router.push).toHaveBeenCalledWith(
      "/analytics?range=custom&from=2026-08-15&to=2026-09-01&interval=day",
      { scroll: false },
    );
  });

  it("shows no preset pressed for a custom range", () => {
    render(
      <RangeControls
        current={{
          preset: "custom",
          from: "2026-08-01",
          to: "2026-08-31",
          interval: "week",
          months: 6,
        }}
        today={TODAY}
      />,
    );
    for (const button of within(group("Date range")).getAllByRole("button")) {
      expect(button).toHaveAttribute("aria-pressed", "false");
    }
    expect(within(group("Interval")).getByRole("button", { name: "Week" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("From")).toHaveValue("2026-08-01");
  });

  it("switches from a custom range back to a preset without the dates", async () => {
    const user = userEvent.setup();
    render(
      <RangeControls
        current={{
          preset: "custom",
          from: "2026-08-01",
          to: "2026-08-31",
          interval: "week",
          months: 6,
        }}
        today={TODAY}
      />,
    );
    await user.click(screen.getByRole("button", { name: "12 months" }));
    expect(router.push).toHaveBeenCalledWith("/analytics?range=365&interval=week", {
      scroll: false,
    });
  });
});

describe("CohortMonthsControl", () => {
  it("marks the current months and navigates to another, keeping the range", async () => {
    const user = userEvent.setup();
    render(<CohortMonthsControl current={{ ...LAST_30, preset: 7 }} />);
    const months = group("Cohort months");
    expect(
      within(months)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["6 months", "12 months", "24 months"]);
    expect(within(months).getByRole("button", { name: "6 months" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(within(months).getByRole("button", { name: "24 months" }));
    expect(router.push).toHaveBeenCalledWith("/analytics?range=7&interval=day&months=24", {
      scroll: false,
    });
  });
});
