"use client";

import { useId } from "react";

import { FieldError, TextField } from "@/components/forms/fields";
import { COUNTRIES, layoutFor } from "@/lib/countries";

export interface AddressDraft {
  first_name: string;
  last_name: string;
  company: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postal_code: string;
  country_code: string;
  phone: string;
}

export function emptyAddress(): AddressDraft {
  return {
    first_name: "",
    last_name: "",
    company: "",
    line1: "",
    line2: "",
    city: "",
    region: "",
    postal_code: "",
    country_code: "US",
    phone: "",
  };
}

/** Client-side checks, mirroring the API's; the server re-validates everything. */
export function addressErrors(draft: AddressDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  const layout = layoutFor(draft.country_code);
  if (!draft.first_name.trim()) errors["first_name"] = "Enter a first name.";
  if (!draft.last_name.trim()) errors["last_name"] = "Enter a last name.";
  if (!draft.line1.trim()) errors["line1"] = "Enter a street address.";
  if (!draft.city.trim()) errors["city"] = "Enter a town or city.";
  if (layout.region?.required && !draft.region.trim()) {
    errors["region"] = `Enter a ${layout.region.label.toLowerCase()}.`;
  }
  if (layout.postal) {
    const postal = draft.postal_code.trim();
    if (!postal) errors["postal_code"] = `Enter a ${layout.postal.label.toLowerCase()}.`;
    else if (!layout.postal.pattern.test(postal)) {
      errors["postal_code"] = layout.postal.example
        ? `Enter a ${layout.postal.label.toLowerCase()} like ${layout.postal.example}.`
        : `Check the ${layout.postal.label.toLowerCase()}.`;
    }
  }
  return errors;
}

/*
 * DESIGN-SYSTEM.md §4 "AddressForm": the country drives which fields appear
 * and what they are called; every field carries its `autocomplete` token,
 * sectioned so shipping and billing autofill separately; optional fields
 * say "(optional)" and required ones carry no asterisk.
 */
export function AddressForm({
  legend,
  value,
  onChange,
  errors,
  autocompleteSection,
}: {
  legend: string;
  value: AddressDraft;
  onChange: (next: AddressDraft) => void;
  errors: Record<string, string>;
  autocompleteSection: "shipping" | "billing";
}) {
  const countryId = useId();
  const layout = layoutFor(value.country_code);
  const auto = (token: string) => `section-${autocompleteSection} ${autocompleteSection} ${token}`;
  const field = (name: keyof AddressDraft) => ({
    value: value[name],
    error: errors[name],
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
      onChange({ ...value, [name]: event.target.value });
    },
  });

  return (
    <fieldset className="flex flex-col gap-4">
      <legend className="mb-2 font-medium">{legend}</legend>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={countryId} className="text-sm font-medium">
          Country
        </label>
        <select
          id={countryId}
          autoComplete={auto("country")}
          value={value.country_code}
          onChange={(event) => {
            onChange({ ...value, country_code: event.target.value, region: "", postal_code: "" });
          }}
          aria-invalid={errors["country_code"] ? true : undefined}
          className="border-border-default bg-surface-raised focus-visible:border-border-focus focus-visible:ring-ring/50 h-10 rounded-md border px-3 text-base outline-none focus-visible:ring-[3px]"
        >
          {COUNTRIES.map((country) => (
            <option key={country.code} value={country.code}>
              {country.name}
            </option>
          ))}
        </select>
        <FieldError id={`${countryId}-error`} message={errors["country_code"]} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="First name" autoComplete={auto("given-name")} {...field("first_name")} />
        <TextField label="Last name" autoComplete={auto("family-name")} {...field("last_name")} />
      </div>
      <TextField
        label="Company"
        optional
        autoComplete={auto("organization")}
        {...field("company")}
      />
      <TextField label="Address" autoComplete={auto("address-line1")} {...field("line1")} />
      <TextField
        label="Apartment, suite, etc."
        optional
        autoComplete={auto("address-line2")}
        {...field("line2")}
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField label="Town or city" autoComplete={auto("address-level2")} {...field("city")} />
        {layout.region && (
          <TextField
            label={layout.region.label}
            optional={!layout.region.required}
            autoComplete={auto("address-level1")}
            {...field("region")}
          />
        )}
        {layout.postal && (
          <TextField
            label={layout.postal.label}
            autoComplete={auto("postal-code")}
            autoCapitalize="characters"
            placeholder={layout.postal.example || undefined}
            {...field("postal_code")}
          />
        )}
      </div>
      <TextField
        label="Phone"
        optional
        type="tel"
        autoComplete={auto("tel")}
        hint="Only used if the courier needs to reach you."
        {...field("phone")}
      />
    </fieldset>
  );
}
