/**
 * Address layouts per country (DESIGN-SYSTEM.md §4 "AddressForm"): which
 * fields appear, what they are called, and the postcode shape checked on blur.
 * A country missing here gets the generic layout — the API validates anyway.
 */

export interface CountryLayout {
  code: string;
  name: string;
  region: { label: string; required: boolean } | null;
  postal: { label: string; pattern: RegExp; example: string } | null;
}

const GENERIC: Omit<CountryLayout, "code" | "name"> = {
  region: { label: "State / province / region", required: false },
  postal: { label: "Postal code", pattern: /^[A-Za-z0-9 -]{2,10}$/, example: "" },
};

export const COUNTRIES: CountryLayout[] = [
  {
    code: "US",
    name: "United States",
    region: { label: "State", required: true },
    postal: { label: "ZIP code", pattern: /^\d{5}(-\d{4})?$/, example: "94103" },
  },
  {
    code: "GB",
    name: "United Kingdom",
    region: { label: "County", required: false },
    postal: {
      label: "Postcode",
      pattern: /^[A-Za-z]{1,2}\d[A-Za-z\d]? ?\d[A-Za-z]{2}$/,
      example: "SW1A 1AA",
    },
  },
  {
    code: "CA",
    name: "Canada",
    region: { label: "Province", required: true },
    postal: {
      label: "Postal code",
      pattern: /^[A-Za-z]\d[A-Za-z] ?\d[A-Za-z]\d$/,
      example: "K1A 0B1",
    },
  },
  {
    code: "IE",
    name: "Ireland",
    region: { label: "County", required: false },
    postal: { label: "Eircode", pattern: /^[A-Za-z0-9]{3} ?[A-Za-z0-9]{4}$/, example: "D02 X285" },
  },
  {
    code: "DE",
    name: "Germany",
    region: null,
    postal: { label: "Postleitzahl", pattern: /^\d{5}$/, example: "10115" },
  },
  {
    code: "FR",
    name: "France",
    region: null,
    postal: { label: "Code postal", pattern: /^\d{5}$/, example: "75001" },
  },
  {
    code: "NL",
    name: "Netherlands",
    region: null,
    postal: { label: "Postcode", pattern: /^\d{4} ?[A-Za-z]{2}$/, example: "1012 AB" },
  },
  {
    code: "AU",
    name: "Australia",
    region: { label: "State / territory", required: true },
    postal: { label: "Postcode", pattern: /^\d{4}$/, example: "2000" },
  },
  {
    code: "NG",
    name: "Nigeria",
    region: { label: "State", required: true },
    postal: null,
  },
  {
    code: "GH",
    name: "Ghana",
    region: { label: "Region", required: true },
    postal: null,
  },
  {
    code: "KE",
    name: "Kenya",
    region: { label: "County", required: false },
    postal: { label: "Postal code", pattern: /^\d{5}$/, example: "00100" },
  },
  {
    code: "ZA",
    name: "South Africa",
    region: { label: "Province", required: true },
    postal: { label: "Postal code", pattern: /^\d{4}$/, example: "8001" },
  },
];

export function layoutFor(code: string): CountryLayout {
  return (
    COUNTRIES.find((country) => country.code === code.toUpperCase()) ?? {
      code,
      name: code,
      ...GENERIC,
    }
  );
}
