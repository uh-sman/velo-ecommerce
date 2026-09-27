import { describe, expect, it } from "vitest";
import { formatMoney, isProblemDetail } from "./index";

// Intl separates the currency code from the amount with a no-break space.
const normalise = (s: string) => s.replaceAll(String.fromCharCode(0xa0), " ");

describe("formatMoney", () => {
  it("divides two-decimal currencies by 100", () => {
    expect(formatMoney({ amount: 1999, currency: "USD" })).toBe("$19.99");
  });

  it("does not divide currencies with no minor unit (JPY)", () => {
    expect(formatMoney({ amount: 500, currency: "JPY" })).toBe("¥500");
  });

  it("divides three-decimal currencies by 1000 (KWD)", () => {
    expect(normalise(formatMoney({ amount: 1500, currency: "KWD" }))).toBe("KWD 1.500");
  });

  it("formats zero and negative amounts", () => {
    expect(formatMoney({ amount: 0, currency: "USD" })).toBe("$0.00");
    expect(formatMoney({ amount: -250, currency: "USD" })).toBe("-$2.50");
  });

  it("respects the locale", () => {
    expect(normalise(formatMoney({ amount: 123456, currency: "EUR" }, "de-DE"))).toBe("1.234,56 €");
  });
});

describe("isProblemDetail", () => {
  it("accepts an RFC 9457 body", () => {
    expect(
      isProblemDetail({ type: "https://velo.dev/errors/conflict", title: "Conflict", status: 409 }),
    ).toBe(true);
  });

  it.each([null, undefined, "error", 500, {}, { type: "x", title: "y" }])("rejects %j", (value) => {
    expect(isProblemDetail(value)).toBe(false);
  });
});
