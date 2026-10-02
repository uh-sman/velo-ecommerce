import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { OrderSummary } from "@/components/commerce/order-summary";
import { totals, usd } from "@/test/fixtures/commerce";

function row(label: string | RegExp) {
  const term = screen.getByText(label, { selector: "dt, dt *" });
  const pair = term.closest("div");
  if (!pair) throw new Error("row not found");
  return pair;
}

describe("OrderSummary", () => {
  it("says 'Calculated at checkout' for unknown shipping and tax, never $0.00", () => {
    render(<OrderSummary totals={totals()} itemCount={1} />);
    expect(screen.getByRole("region", { name: "Order summary" })).toBeInTheDocument();
    expect(row("Subtotal (1 item)")).toHaveTextContent("$45.00");
    expect(row("Shipping")).toHaveTextContent("Calculated at checkout");
    expect(row("Tax")).toHaveTextContent("Calculated at checkout");
    expect(row("Total")).toHaveTextContent("$45.00");
    expect(screen.queryByText("Discount")).not.toBeInTheDocument();
  });

  it("shows known shipping with its label, tax, and an aggregate discount", () => {
    render(
      <OrderSummary
        totals={totals({
          subtotal: usd(9000),
          discount: usd(1000),
          shipping: usd(500),
          tax: usd(720),
          total: usd(9220),
        })}
        itemCount={2}
        shippingLabel="Standard"
      >
        <button type="button">Pay</button>
      </OrderSummary>,
    );
    expect(row("Subtotal (2 items)")).toHaveTextContent("$90.00");
    expect(row("Discount")).toHaveTextContent("−$10.00");
    expect(row("Shipping — Standard")).toHaveTextContent("$5.00");
    expect(row("Tax")).toHaveTextContent("$7.20");
    expect(screen.getByRole("button", { name: "Pay" })).toBeInTheDocument();
  });

  it("shows included tax instead of added tax", () => {
    render(<OrderSummary totals={totals({ tax_included: usd(750) })} itemCount={1} />);
    expect(row("Tax (included)")).toHaveTextContent("$7.50");
    expect(screen.queryByText("Tax")).not.toBeInTheDocument();
  });

  it("itemises discounts and lets a code be removed", async () => {
    const onRemoveCode = vi.fn();
    render(
      <OrderSummary
        totals={totals({ discount: usd(1500) })}
        itemCount={1}
        discounts={[
          { code: "SPRING10", title: "Spring sale", amount: usd(1000) },
          { code: null, title: "Loyalty", amount: usd(500) },
        ]}
        onRemoveCode={onRemoveCode}
      />,
    );
    const coded = row(/Discount \(SPRING10\)/);
    expect(coded).toHaveTextContent("−$10.00");
    expect(row(/Loyalty/)).toHaveTextContent("−$5.00");
    expect(within(row(/Loyalty/)).queryByRole("button")).not.toBeInTheDocument();

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Remove discount code SPRING10" }));
    expect(onRemoveCode).toHaveBeenCalledTimes(1);
  });

  it("offers no Remove button without a handler", () => {
    render(
      <OrderSummary
        totals={totals()}
        itemCount={1}
        discounts={[{ code: "SPRING10", title: "Spring", amount: usd(1000) }]}
      />,
    );
    expect(screen.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
  });
});
