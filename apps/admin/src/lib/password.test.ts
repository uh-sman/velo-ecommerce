import { describe, expect, it } from "vitest";

import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordRequirements,
  passwordStrength,
} from "@/lib/password";

function met(password: string, email = "") {
  return Object.fromEntries(
    passwordRequirements(password, email).map((requirement) => [requirement.id, requirement.met]),
  );
}

describe("passwordRequirements", () => {
  it("labels the length rule with the minimum", () => {
    expect(passwordRequirements("")[0]?.label).toBe(
      `At least ${String(PASSWORD_MIN_LENGTH)} characters`,
    );
  });

  it("meets nothing for an empty password", () => {
    expect(met("")).toEqual({ length: false, email: false });
  });

  it("checks the length window", () => {
    expect(met("a".repeat(PASSWORD_MIN_LENGTH - 1)).length).toBe(false);
    expect(met("a".repeat(PASSWORD_MIN_LENGTH)).length).toBe(true);
    expect(met("a".repeat(PASSWORD_MAX_LENGTH + 1)).length).toBe(false);
  });

  it("rejects the email address or its local part, ignoring case and spaces", () => {
    expect(met("Ada@Example.com", "ada@example.com").email).toBe(false);
    expect(met("  ADA ", "ada@example.com").email).toBe(false);
    expect(met("lovelace-1815", "ada@example.com").email).toBe(true);
  });

  it("passes the email rule with no email to compare", () => {
    expect(met("anything")).toEqual({ length: false, email: true });
  });
});

describe("passwordStrength", () => {
  it.each([
    ["", "empty"],
    ["Ab1!", "weak"],
    ["aaaaaaaaaaaa", "weak"],
    ["abcdefghij", "fair"],
    ["correct horse battery staple", "strong"],
    ["Tr0ub4dor&3xyz", "strong"],
  ] as const)("%j is %s", (password, strength) => {
    expect(passwordStrength(password)).toBe(strength);
  });
});
