import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StatusBadge, statusLabel } from "@/components/orders/status";

describe("statusLabel", () => {
  it("uses the shared customer-facing vocabulary", () => {
    expect(statusLabel("paid")).toBe("Confirmed");
    expect(statusLabel("partially_fulfilled")).toBe("Partly shipped");
    expect(statusLabel("failed")).toBe("Delivery failed");
  });

  it("falls back to a readable form of an unknown status", () => {
    expect(statusLabel("on_hold_for_review")).toBe("on hold for review");
  });
});

describe("StatusBadge", () => {
  it("shows the label, tinted by tone", () => {
    render(<StatusBadge status="delivered" className="extra" />);
    const badge = screen.getByText("Delivered");
    expect(badge).toHaveClass("text-success", "extra");
  });

  it.each([
    ["rejected", "text-danger"],
    ["refunded", "text-warning"],
    ["approved", "text-info"],
    ["cancelled", "text-text-secondary"],
    ["mystery_state", "text-text-secondary"],
  ])("gives %s the %s tone", (status, tone) => {
    render(<StatusBadge status={status} />);
    expect(screen.getByText(statusLabel(status))).toHaveClass(tone);
  });
});
