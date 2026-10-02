import { describe, expect, it } from "vitest";

import { addressErrors, emptyAddress } from "@/components/checkout/address-form";
import { pollDelay } from "@/components/checkout/confirmation";
import { AttemptKey } from "@/lib/idempotency";

function failure(status: number) {
  return {
    ok: false as const,
    problem: { type: "https://velo.dev/errors/x", title: "x", status },
  };
}

describe("AttemptKey", () => {
  it("keeps the key across retries of an attempt that may have reached the server", () => {
    const attempt = new AttemptKey();
    const first = attempt.current;
    for (const status of [0, 409, 500, 503]) {
      attempt.settle(failure(status));
      expect(attempt.current).toBe(first);
    }
  });

  it("mints a new key after a definitive answer", () => {
    const attempt = new AttemptKey();
    const first = attempt.current;
    attempt.settle({ ok: true, data: null });
    const second = attempt.current;
    expect(second).not.toBe(first);
    attempt.settle(failure(422));
    expect(attempt.current).not.toBe(second);
  });
});

describe("pollDelay", () => {
  it("polls every 2 s for 30 s, then every 5 s, then stops at 3 minutes", () => {
    expect(pollDelay(0)).toBe(2000);
    expect(pollDelay(29_999)).toBe(2000);
    expect(pollDelay(30_000)).toBe(5000);
    expect(pollDelay(179_999)).toBe(5000);
    expect(pollDelay(180_000)).toBeNull();
  });
});

describe("addressErrors", () => {
  const complete = {
    ...emptyAddress(),
    first_name: "Ada",
    last_name: "Lovelace",
    line1: "1 Market St",
    city: "San Francisco",
    region: "CA",
    postal_code: "94103",
  };

  it("accepts a complete US address", () => {
    expect(addressErrors(complete)).toEqual({});
  });

  it("checks the postcode against the country's format", () => {
    expect(addressErrors({ ...complete, postal_code: "SW1A 1AA" })).toHaveProperty("postal_code");
    expect(
      addressErrors({ ...complete, country_code: "GB", region: "", postal_code: "SW1A 1AA" }),
    ).toEqual({});
  });

  it("does not ask for a postcode where the country has none", () => {
    expect(
      addressErrors({ ...complete, country_code: "NG", region: "Lagos", postal_code: "" }),
    ).toEqual({});
  });

  it("names every missing required field", () => {
    expect(Object.keys(addressErrors(emptyAddress())).sort()).toEqual(
      ["city", "first_name", "last_name", "line1", "postal_code", "region"].sort(),
    );
  });
});
