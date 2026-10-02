import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StatusBadge, statusLabel } from "@/components/status";

describe("statusLabel", () => {
  it.each([
    ["paid", "Confirmed"],
    ["partially_fulfilled", "Partly shipped"],
    ["failed", "Delivery failed"],
  ])("labels %s as %s", (status, label) => {
    expect(statusLabel(status)).toBe(label);
  });

  it("humanises an unknown status", () => {
    expect(statusLabel("on_hold_for_review")).toBe("on hold for review");
  });
});

describe("StatusBadge", () => {
  it.each([
    ["pending", "Pending", "bg-surface-sunken"],
    ["processing", "Preparing", "bg-info/10"],
    ["delivered", "Delivered", "bg-success/10"],
    ["refunded", "Refunded", "bg-warning/10"],
    ["rejected", "Rejected", "bg-danger/10"],
    ["mystery", "mystery", "bg-surface-sunken"],
  ])("shows %s as the text %s with its tone", (status, label, toneClass) => {
    render(<StatusBadge status={status} className="extra" />);
    const badge = screen.getByText(label);
    expect(badge).toHaveClass(toneClass, "extra");
  });
});
