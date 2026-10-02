import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { QuantityStepper } from "@/components/commerce/quantity-stepper";

function setup(props: Partial<Parameters<typeof QuantityStepper>[0]> = {}) {
  const onChange = vi.fn();
  const view = render(
    <QuantityStepper value={2} max={5} label="Trail Tee" onChange={onChange} {...props} />,
  );
  return { onChange, view, user: userEvent.setup() };
}

describe("QuantityStepper", () => {
  it("labels its controls with the product", () => {
    setup();
    expect(screen.getByRole("textbox", { name: "Quantity of Trail Tee" })).toHaveValue("2");
    expect(screen.getByRole("button", { name: "Decrease quantity of Trail Tee" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Increase quantity of Trail Tee" })).toBeEnabled();
  });

  it("debounces repeated clicks into one change", async () => {
    const { onChange, user } = setup();
    const plus = screen.getByRole("button", { name: "Increase quantity of Trail Tee" });
    await user.click(plus);
    await user.click(plus);
    expect(screen.getByRole("textbox")).toHaveValue("4");
    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(4);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("disables − at 1 and + at the stock cap", async () => {
    const { user } = setup({ value: 1, max: 2 });
    expect(screen.getByRole("button", { name: /Decrease/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /Increase/ }));
    expect(screen.getByRole("button", { name: /Increase/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Decrease/ })).toBeEnabled();
  });

  it("clamps typed values to the cap and ignores non-digits", async () => {
    const { onChange, user } = setup();
    const input = screen.getByRole("textbox");
    await user.clear(input);
    expect(input).toHaveValue("2");
    await user.type(input, "9");
    expect(input).toHaveValue("5");
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(5);
    });
  });

  it("does not report a change that lands back on the current value", async () => {
    const { onChange, user } = setup();
    await user.click(screen.getByRole("button", { name: /Increase/ }));
    await user.click(screen.getByRole("button", { name: /Decrease/ }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("follows the parent's value, so a refused change rolls back", () => {
    const { view } = setup();
    view.rerender(<QuantityStepper value={3} max={5} label="Trail Tee" onChange={vi.fn()} />);
    expect(screen.getByRole("textbox")).toHaveValue("3");
  });

  it("disables everything while busy", () => {
    setup({ disabled: true });
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: /Decrease/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Increase/ })).toBeDisabled();
  });

  it("clears a pending change on unmount", async () => {
    const { onChange, user, view } = setup();
    await user.click(screen.getByRole("button", { name: /Increase/ }));
    view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(onChange).not.toHaveBeenCalled();
  });
});
