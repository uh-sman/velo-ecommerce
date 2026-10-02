import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { NativeSelect } from "./native-select";

const OPTIONS = [
  { value: "", label: "Any" },
  { value: "paid", label: "Paid" },
];

describe("NativeSelect", () => {
  it("is a labelled select that reports changes", async () => {
    const onChange = vi.fn();
    render(<NativeSelect label="Payment" options={OPTIONS} value="" onChange={onChange} />);
    const select = screen.getByRole("combobox", { name: "Payment" });
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Any",
      "Paid",
    ]);
    await userEvent.setup().selectOptions(select, "paid");
    expect(onChange).toHaveBeenCalled();
  });

  it("can hide its label visually and still be named", () => {
    render(<NativeSelect label="Sort" options={OPTIONS} hideLabel disabled />);
    expect(screen.getByText("Sort")).toHaveClass("sr-only");
    expect(screen.getByRole("combobox", { name: "Sort" })).toBeDisabled();
  });
});
