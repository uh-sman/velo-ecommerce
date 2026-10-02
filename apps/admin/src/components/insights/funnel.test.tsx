import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { funnelSteps } from "@/test/fixtures/insights";

import { Funnel } from "./funnel";

function steps() {
  return within(screen.getByRole("list", { name: "Conversion funnel" })).getAllByRole("listitem");
}

describe("Funnel", () => {
  it("lists every step with its count and the rate from the step before", () => {
    render(<Funnel steps={funnelSteps(1_200, 600, 450, 300)} />);
    const [carts, checkouts, payments, orders] = steps();

    expect(carts).toHaveTextContent("Carts created1,200");
    expect(carts).not.toHaveTextContent("continued");
    expect(checkouts).toHaveTextContent("50% continued");
    expect(checkouts).toHaveTextContent("Checkouts started600");
    expect(payments).toHaveTextContent("75% continued");
    expect(payments).toHaveTextContent("Payments started450");
    expect(orders).toHaveTextContent("66.7% continued");
    expect(orders).toHaveTextContent("Orders placed300");

    expect(screen.getByText("Carts to orders:").parentElement).toHaveTextContent(
      "Carts to orders: 25%",
    );
  });

  it("prints a later step that outgrows an earlier one as it is", () => {
    render(<Funnel steps={funnelSteps(10, 5, 4, 8)} />);
    expect(steps()[3]).toHaveTextContent("200% continued");
  });

  it("explains a missing rate when the step before had none", () => {
    render(<Funnel steps={funnelSteps(5, 0, 0, 0)} />);
    expect(steps()[2]).toHaveTextContent("no rate (none at the step before)");
    expect(screen.getByText("Carts to orders:").parentElement).toHaveTextContent("0%");
  });

  it("shows a dash and a note when there were no carts", () => {
    render(<Funnel steps={funnelSteps(0, 0, 0, 0)} />);
    const footer = screen.getByText("Carts to orders:").parentElement;
    expect(footer).toHaveTextContent("Carts to orders: —");
    expect(footer).toHaveTextContent("No carts in this period");
  });

  it("falls back to the raw step name for an unknown step", () => {
    render(<Funnel steps={[{ step: "wishlists", count: 3 }]} />);
    expect(steps()[0]).toHaveTextContent("wishlists3");
  });

  it("scales bars to the largest step and draws none for an empty step", () => {
    const { container } = render(<Funnel steps={funnelSteps(200, 100, 0, 1)} compact />);
    const tracks = container.querySelectorAll<HTMLElement>("li > div[aria-hidden]");
    expect(tracks).toHaveLength(4);
    expect(tracks[0]?.style.height).toBe("14px");
    expect((tracks[0]?.firstElementChild as HTMLElement | null)?.style.width).toBe("100%");
    expect((tracks[1]?.firstElementChild as HTMLElement | null)?.style.width).toBe("50%");
    expect(tracks[2]?.childElementCount).toBe(0);
    // A tiny step keeps a visible sliver.
    expect((tracks[3]?.firstElementChild as HTMLElement | null)?.style.width).toBe("0.75%");
  });

  it("renders an empty funnel without steps", () => {
    render(<Funnel steps={[]} />);
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.getByText("No carts in this period", { exact: false })).toBeInTheDocument();
  });
});
