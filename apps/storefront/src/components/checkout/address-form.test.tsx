import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  AddressForm,
  addressErrors,
  emptyAddress,
  type AddressDraft,
} from "@/components/checkout/address-form";

function Harness({
  initial = emptyAddress(),
  errors = {},
  onChange,
}: {
  initial?: AddressDraft;
  errors?: Record<string, string>;
  onChange?: (next: AddressDraft) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <AddressForm
      legend="Shipping address"
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
      errors={errors}
      autocompleteSection="shipping"
    />
  );
}

describe("AddressForm", () => {
  it("groups the fields under the legend with sectioned autocomplete tokens", () => {
    render(<Harness />);
    const group = screen.getByRole("group", { name: "Shipping address" });
    expect(within(group).getByLabelText("First name")).toHaveAttribute(
      "autocomplete",
      "section-shipping shipping given-name",
    );
    expect(within(group).getByLabelText("Country")).toHaveAttribute(
      "autocomplete",
      "section-shipping shipping country",
    );
    expect(within(group).getByLabelText("ZIP code")).toHaveAttribute("placeholder", "94103");
  });

  it("marks optional fields in their label and leaves required ones plain", () => {
    render(<Harness />);
    expect(screen.getByLabelText("Company (optional)")).toBeInTheDocument();
    expect(screen.getByLabelText("Apartment, suite, etc. (optional)")).toBeInTheDocument();
    expect(screen.getByLabelText("Phone (optional)")).toHaveAttribute("type", "tel");
    expect(screen.getByLabelText("State")).toBeInTheDocument();
  });

  it("reports each edit with the rest of the draft intact", async () => {
    const onChange = vi.fn<(next: AddressDraft) => void>();
    render(<Harness onChange={onChange} />);
    await userEvent.setup().type(screen.getByLabelText("Town or city"), "Oslo");
    expect(onChange).toHaveBeenLastCalledWith({ ...emptyAddress(), city: "Oslo" });
  });

  it("relabels region and postcode for the chosen country and clears them", async () => {
    const onChange = vi.fn<(next: AddressDraft) => void>();
    render(
      <Harness
        initial={{ ...emptyAddress(), region: "CA", postal_code: "94103" }}
        onChange={onChange}
      />,
    );
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Country"), "GB");
    expect(onChange).toHaveBeenLastCalledWith({
      ...emptyAddress(),
      country_code: "GB",
      region: "",
      postal_code: "",
    });
    expect(screen.getByLabelText("County (optional)")).toBeInTheDocument();
    expect(screen.getByLabelText("Postcode")).toHaveAttribute("placeholder", "SW1A 1AA");

    await user.selectOptions(screen.getByLabelText("Country"), "DE");
    expect(screen.queryByLabelText(/County/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Postleitzahl")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Country"), "NG");
    expect(screen.getByLabelText("State")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Postcode|Postal code|ZIP/)).not.toBeInTheDocument();
  });

  it("uses the generic layout for a country it does not know", () => {
    render(<Harness initial={{ ...emptyAddress(), country_code: "JP" }} />);
    expect(screen.getByLabelText("State / province / region (optional)")).toBeInTheDocument();
    expect(screen.getByLabelText("Postal code")).not.toHaveAttribute("placeholder");
  });

  it("links each error to its field and marks it invalid", () => {
    render(
      <Harness
        errors={{ first_name: "Enter a first name.", country_code: "We do not ship there." }}
      />,
    );
    const first = screen.getByLabelText("First name");
    expect(first).toHaveAttribute("aria-invalid", "true");
    expect(first).toHaveAccessibleDescription("Enter a first name.");
    expect(screen.getByLabelText("Country")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("We do not ship there.")).toBeInTheDocument();
    expect(screen.getByLabelText("Last name")).not.toHaveAttribute("aria-invalid");
  });
});

describe("addressErrors postcode messages", () => {
  const base = {
    ...emptyAddress(),
    first_name: "Ada",
    last_name: "Lovelace",
    line1: "1 Main St",
    city: "Town",
  };

  it("gives an example when the country has one", () => {
    expect(addressErrors({ ...base, region: "CA", postal_code: "nope" })["postal_code"]).toBe(
      "Enter a zip code like 94103.",
    );
  });

  it("asks to check the code when the country has no example", () => {
    expect(addressErrors({ ...base, country_code: "JP", postal_code: "!" })["postal_code"]).toBe(
      "Check the postal code.",
    );
  });

  it("names the region by its local label", () => {
    expect(addressErrors({ ...base, country_code: "CA", postal_code: "K1A 0B1" })).toEqual({
      region: "Enter a province.",
    });
  });
});
