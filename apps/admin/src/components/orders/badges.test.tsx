import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FulfilmentBadge, PaymentBadge, RefundBadge } from "./badges";

describe("order badges", () => {
  it("give payment states their own words", () => {
    render(
      <>
        <PaymentBadge status="pending" />
        <PaymentBadge status="paid" />
        <PaymentBadge status="partially_refunded" />
        <PaymentBadge status="refunded" />
        <PaymentBadge status="failed" className="extra" />
      </>,
    );
    for (const label of ["Unpaid", "Paid", "Partly refunded", "Refunded", "Payment failed"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText("Payment failed")).toHaveClass("extra", "text-danger");
    expect(screen.getByText("Paid")).toHaveClass("text-success");
    expect(screen.getByText("Refunded")).toHaveClass("text-text-secondary");
  });

  it("give fulfilment states their own words", () => {
    render(
      <>
        <FulfilmentBadge status="unfulfilled" />
        <FulfilmentBadge status="partially_fulfilled" />
        <FulfilmentBadge status="fulfilled" />
        <FulfilmentBadge status="returned" />
      </>,
    );
    expect(screen.getByText("Unfulfilled")).toHaveClass("text-warning");
    expect(screen.getByText("Partly shipped")).toHaveClass("text-info");
    expect(screen.getByText("Shipped")).toBeInTheDocument();
    expect(screen.getByText("Returned")).toBeInTheDocument();
  });

  it("give refund states their own words", () => {
    render(
      <>
        <RefundBadge status="pending" />
        <RefundBadge status="succeeded" />
        <RefundBadge status="failed" />
        <RefundBadge status="cancelled" />
      </>,
    );
    for (const label of ["Pending", "Refunded", "Failed", "Cancelled"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("spell out an unknown status rather than hide it", () => {
    render(
      <>
        <PaymentBadge status="requires_action" />
        <FulfilmentBadge status="on_hold" />
        <RefundBadge status="requires_review" />
      </>,
    );
    expect(screen.getByText("requires action")).toHaveClass("text-text-secondary");
    expect(screen.getByText("on hold")).toBeInTheDocument();
    expect(screen.getByText("requires review")).toBeInTheDocument();
  });
});
