import { describe, expect, it } from "vitest";

import { passwordRequirements, passwordStrength } from "@/lib/password";

const met = (password: string, email = "") =>
  Object.fromEntries(passwordRequirements(password, email).map((r) => [r.id, r.met]));

describe("passwordRequirements", () => {
  it("requires 10 to 128 characters", () => {
    expect(met("short")).toMatchObject({ length: false });
    expect(met("long enough")).toMatchObject({ length: true });
    expect(met("x".repeat(129))).toMatchObject({ length: false });
  });

  it("rejects the email address or its local part", () => {
    expect(met("", "ada@example.com")).toMatchObject({ email: false });
    expect(met("Ada@Example.com", "ada@example.com")).toMatchObject({ email: false });
    expect(met("ADA", "ada@example.com")).toMatchObject({ email: false });
    expect(met("something else", "ada@example.com")).toMatchObject({ email: true });
    expect(met("anything")).toMatchObject({ email: true });
  });
});

describe("passwordStrength", () => {
  it.each([
    ["", "empty"],
    ["Ab1!", "weak"],
    ["aaaaaaaaaaaa", "weak"],
    ["abcdefghij", "fair"],
    ["correct horse battery staple", "strong"],
  ])("%j is %s", (password, strength) => {
    expect(passwordStrength(password)).toBe(strength);
  });
});
