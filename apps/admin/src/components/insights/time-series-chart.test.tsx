import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TimeSeriesChart, type SeriesPoint } from "./time-series-chart";

/*
 * jsdom has no layout: every box measures 0×0, and the chart draws nothing
 * until it knows its width. Give elements a 600px box, and capture the
 * ResizeObserver callback so a test can resize the chart.
 */
const WIDTH = 600;
let resize: ((width: number) => void) | null = null;

class FakeResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe() {
    resize = (width) => {
      this.callback([{ contentRect: { width } } as ResizeObserverEntry], this);
    };
  }
  unobserve() {}
  disconnect() {
    resize = null;
  }
}

function box(width: number): DOMRect {
  return {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: width,
    bottom: 200,
    width,
    height: 200,
    toJSON: () => ({}),
  };
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(box(WIDTH));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resize = null;
});

const POINTS: SeriesPoint[] = [
  { period: "2026-09-01", value: 1_000 },
  { period: "2026-09-02", value: 0 },
  { period: "2026-09-03", value: 4_500 },
];

const changes: (number | null)[] = [];

function Chart({
  points = POINTS,
  kind = "area",
  initial = null,
  height,
}: {
  points?: SeriesPoint[];
  kind?: "area" | "bars";
  initial?: number | null;
  height?: number;
}) {
  const [active, setActive] = useState<number | null>(initial);
  return (
    <TimeSeriesChart
      label="Revenue per day, Sep 1, 2026 to Sep 3, 2026"
      points={points}
      kind={kind}
      interval="day"
      formatValue={(value) => `$${value.toFixed(2)}`}
      formatTick={(value) => `$${String(value)}`}
      {...(height === undefined ? {} : { height })}
      active={active}
      onActiveChange={(index) => {
        changes.push(index);
        setActive(index);
      }}
    />
  );
}

function slider() {
  return screen.getByRole("slider", { name: /Revenue per day/ });
}

/**
 * jsdom has no PointerEvent with coordinates, and `fireEvent.pointerMove`
 * drops `clientX`; React only looks at the event type, so a MouseEvent does.
 */
function pointer(target: Element, type: "pointermove" | "pointerdown", clientX: number) {
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX }));
  });
}

function plot(container: HTMLElement): SVGRectElement {
  const rect = container.querySelector("rect");
  if (!rect) throw new Error("No plot area");
  return rect;
}

describe("TimeSeriesChart", () => {
  beforeEach(() => {
    changes.length = 0;
  });

  it("is a keyboard-operable slider that names its series and how to read it", () => {
    render(<Chart />);
    const chart = slider();
    expect(chart).toHaveAccessibleName(
      "Revenue per day, Sep 1, 2026 to Sep 3, 2026. Use the arrow keys to read each day.",
    );
    expect(chart).toHaveAttribute("tabindex", "0");
    expect(chart).toHaveAttribute("aria-valuemin", "0");
    expect(chart).toHaveAttribute("aria-valuemax", "2");
    expect(chart).toHaveAttribute("aria-valuenow", "0");
    expect(chart).toHaveAttribute("aria-valuetext", "Use the arrow keys to read values");
    expect(chart).toHaveStyle({ height: "200px" });
  });

  it("steps through buckets with the arrow keys and announces each readout", async () => {
    const user = userEvent.setup();
    render(<Chart />);
    await user.tab();
    expect(slider()).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    expect(slider()).toHaveAttribute("aria-valuetext", "Sep 1, 2026: $1000.00");
    expect(slider()).toHaveAttribute("aria-valuenow", "0");

    await user.keyboard("{ArrowRight}");
    // A zero day is a real bucket, read as zero.
    expect(slider()).toHaveAttribute("aria-valuetext", "Sep 2, 2026: $0.00");

    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(slider()).toHaveAttribute("aria-valuenow", "2");

    await user.keyboard("{ArrowLeft}");
    expect(slider()).toHaveAttribute("aria-valuenow", "1");
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(slider()).toHaveAttribute("aria-valuenow", "0");

    await user.keyboard("{End}");
    expect(slider()).toHaveAttribute("aria-valuetext", "Sep 3, 2026: $4500.00");
    await user.keyboard("{Home}");
    expect(slider()).toHaveAttribute("aria-valuenow", "0");

    await user.keyboard("{Escape}");
    expect(slider()).toHaveAttribute("aria-valuetext", "Use the arrow keys to read values");
    expect(changes.at(-1)).toBeNull();
  });

  it("starts from the last bucket on ArrowLeft", async () => {
    const user = userEvent.setup();
    render(<Chart />);
    await user.tab();
    await user.keyboard("{ArrowLeft}");
    expect(slider()).toHaveAttribute("aria-valuenow", "2");
  });

  it("ignores other keys", async () => {
    const user = userEvent.setup();
    render(<Chart />);
    await user.tab();
    await user.keyboard("a{Enter}");
    expect(changes).toEqual([]);
  });

  it("clears the readout when focus leaves", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Chart />
        <button type="button">Next</button>
      </>,
    );
    await user.tab();
    await user.keyboard("{ArrowRight}");
    await user.tab();
    expect(screen.getByRole("button", { name: "Next" })).toHaveFocus();
    expect(changes.at(-1)).toBeNull();
    expect(slider()).toHaveAttribute("aria-valuetext", "Use the arrow keys to read values");
  });

  it("shows a tooltip and crosshair for the bucket under the pointer", () => {
    const { container } = render(<Chart />);
    const area = plot(container);

    pointer(area, "pointermove", WIDTH * 10);
    expect(changes.at(-1)).toBe(2);
    expect(screen.getByText("Sep 3, 2026")).toBeInTheDocument();
    expect(screen.getByText("$4500.00")).toBeInTheDocument();
    // Crosshair: one more line than the gridlines, plus the active dot.
    expect(container.querySelectorAll("circle")).toHaveLength(1);

    pointer(area, "pointerdown", -50);
    expect(changes.at(-1)).toBe(0);
    expect(screen.getByText("$1000.00")).toBeInTheDocument();

    fireEvent.pointerLeave(area);
    expect(changes.at(-1)).toBeNull();
    expect(screen.queryByText("$1000.00")).not.toBeInTheDocument();
  });

  it("draws the area with an end dot only while nothing is active", () => {
    const { container } = render(<Chart />);
    // Area wash + line.
    expect(container.querySelectorAll("path")).toHaveLength(2);
    const dot = container.querySelector("circle");
    expect(dot).not.toBeNull();
    pointer(plot(container), "pointermove", 0);
    // The end dot is replaced by the active dot.
    expect(container.querySelectorAll("circle")).toHaveLength(1);
  });

  it("draws a single point as a line without a wash", () => {
    const { container } = render(<Chart points={[{ period: "2026-09-01", value: 10 }]} />);
    expect(container.querySelectorAll("path")).toHaveLength(1);
  });

  it("draws one column per bucket, with an empty column for zero, dimming the rest", () => {
    const { container } = render(<Chart kind="bars" height={140} />);
    const columns = Array.from(container.querySelectorAll("path"));
    expect(columns).toHaveLength(3);
    expect(columns[0]?.getAttribute("d")).toMatch(/^M.+Z$/);
    expect(columns[1]?.getAttribute("d")).toBe("");
    expect(container.querySelector("circle")).toBeNull();
    expect(slider()).toHaveStyle({ height: "140px" });

    pointer(plot(container), "pointermove", WIDTH * 10);
    expect(columns[2]?.style.opacity).toBe("1");
    expect(columns[0]?.style.opacity).toBe("0.45");
    // Bars have no active dot.
    expect(container.querySelector("circle")).toBeNull();
  });

  it("labels the value axis with round ticks from zero", () => {
    const { container } = render(<Chart />);
    const labels = Array.from(container.querySelectorAll("text"), (text) => text.textContent);
    expect(labels).toEqual(
      expect.arrayContaining(["$0", "$2000", "$4000", "$6000", "Sep 1", "Sep 2", "Sep 3"]),
    );
  });

  it("thins the period labels when buckets outnumber the room", () => {
    const points = Array.from({ length: 60 }, (_, index) => ({
      period: new Date(Date.UTC(2026, 6, 1 + index)).toISOString().slice(0, 10),
      value: index,
    }));
    const { container } = render(<Chart points={points} />);
    const periodLabels = Array.from(container.querySelectorAll("text")).filter(
      (text) => !text.textContent?.startsWith("$"),
    );
    expect(periodLabels.length).toBeGreaterThan(1);
    expect(periodLabels.length).toBeLessThan(60);
    expect(periodLabels[0]).toHaveTextContent("Jul 1");
  });

  it("follows its container's width", () => {
    const { container } = render(<Chart />);
    expect(container.querySelector("svg")).toHaveAttribute("width", String(WIDTH));
    act(() => {
      resize?.(320.7);
    });
    expect(container.querySelector("svg")).toHaveAttribute("width", "320");
  });

  it("draws nothing until it has a width", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(box(0));
    const { container } = render(<Chart />);
    expect(container.querySelector("svg")).toBeNull();
    expect(slider()).toBeInTheDocument();
  });

  it("copes with an empty series", async () => {
    const user = userEvent.setup();
    const { container } = render(<Chart points={[]} />);
    expect(slider()).toHaveAttribute("aria-valuemax", "0");
    await user.tab();
    await user.keyboard("{ArrowRight}{End}");
    pointer(plot(container), "pointermove", 100);
    expect(changes).toEqual([]);
    expect(container.querySelectorAll("path")).toHaveLength(0);
  });
});
