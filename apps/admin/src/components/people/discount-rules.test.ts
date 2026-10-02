import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { discountView } from "@/test/fixtures/people";

import {
  CART_PROBLEMS,
  STATUS_LABEL,
  STATUS_TONE,
  changedFields,
  describeDraft,
  draftFromView,
  draftToFields,
  emptyDraft,
  generateCode,
  toLocalInput,
  valueLabel,
  workedExample,
  type Draft,
} from "./discount-rules";

function draft(overrides: Partial<Draft> = {}): Draft {
  return { ...emptyDraft(), ...overrides };
}

/** The same rendering `shortDate` uses, so assertions hold in any locale. */
function short(value: string, withYear = false): string {
  return new Date(value).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
  });
}

describe("emptyDraft", () => {
  it("starts as an active, automatic percentage discount on everything", () => {
    expect(emptyDraft()).toMatchObject({
      code: "",
      type: "percentage",
      currency: "USD",
      appliesTo: "all",
      targets: [],
      segment: "all",
      stackable: false,
      isActive: true,
    });
  });

  it("uses the currency it is given", () => {
    expect(emptyDraft("EUR").currency).toBe("EUR");
  });
});

describe("toLocalInput", () => {
  it("is blank for a missing instant", () => {
    expect(toLocalInput(null)).toBe("");
    expect(toLocalInput(undefined)).toBe("");
    expect(toLocalInput("")).toBe("");
  });

  it("formats an instant as a datetime-local value in this browser's zone", () => {
    const iso = new Date(2026, 2, 5, 9, 7).toISOString();
    expect(toLocalInput(iso)).toBe("2026-03-05T09:07");
  });
});

describe("draftFromView", () => {
  it("trims a percentage's trailing zeros and blanks the nulls", () => {
    const result = draftFromView(discountView(), []);
    expect(result).toMatchObject({
      code: "SPRING20",
      title: "Spring sale",
      type: "percentage",
      value: "20",
      currency: "USD",
      buyQuantity: "",
      getQuantity: "",
      minSubtotal: "",
      maxRedemptions: "",
      maxPerCustomer: "",
      endsAt: "",
      isActive: true,
    });
    expect(result.startsAt).toBe(toLocalInput("2026-01-01T09:00:00Z"));
  });

  it("shows a fixed amount in major units and keeps every limit", () => {
    const result = draftFromView(
      discountView({
        code: null,
        type: "fixed_amount",
        value: "1050",
        currency: "EUR",
        min_subtotal_amount: 5000,
        max_redemptions: 100,
        max_per_customer: 1,
        is_stackable: true,
        first_order_only: true,
        customer_segment: "returning",
        ends_at: "2026-12-31T23:00:00Z",
        is_active: false,
      }),
      [],
    );
    expect(result).toMatchObject({
      code: "",
      value: "10.50",
      currency: "EUR",
      minSubtotal: "50.00",
      maxRedemptions: "100",
      maxPerCustomer: "1",
      stackable: true,
      firstOrderOnly: true,
      segment: "returning",
      isActive: false,
    });
    expect(result.endsAt).toBe(toLocalInput("2026-12-31T23:00:00Z"));
  });

  it("names targets from the labels, and marks the ones it cannot name", () => {
    const result = draftFromView(
      discountView({
        type: "buy_x_get_y",
        value: "100",
        buy_quantity: 2,
        get_quantity: 1,
        applies_to: "products",
        target_ids: ["p1", "p2"],
      }),
      [{ id: "p1", label: "Trail runner" }],
    );
    expect(result.buyQuantity).toBe("2");
    expect(result.getQuantity).toBe("1");
    expect(result.targets).toEqual([
      { id: "p1", label: "Trail runner" },
      { id: "p2", label: "Unknown item" },
    ]);
  });

  it("keeps a value that is not a number as it is", () => {
    expect(draftFromView(discountView({ value: "abc" }), []).value).toBe("abc");
  });
});

describe("draftToFields", () => {
  it("sends an automatic percentage discount with nulls for everything unset", () => {
    expect(draftToFields(draft({ title: "  Spring  ", value: " 15 " }))).toEqual({
      code: null,
      title: "Spring",
      type: "percentage",
      value: "15",
      currency: null,
      min_subtotal_amount: null,
      applies_to: "all",
      target_ids: null,
      first_order_only: false,
      max_redemptions: null,
      max_per_customer: null,
      is_stackable: false,
      starts_at: null,
      ends_at: null,
      is_active: true,
      buy_quantity: null,
      get_quantity: null,
      customer_segment: "all",
    });
  });

  it("upper-cases and trims the code, and defaults a blank value to 0", () => {
    const fields = draftToFields(draft({ code: " spring20 ", value: "  " }));
    expect(fields.code).toBe("SPRING20");
    expect(fields.value).toBe("0");
  });

  it("sends a fixed amount in minor units with its currency", () => {
    const fields = draftToFields(
      draft({ type: "fixed_amount", value: "12.50", currency: " eur ", minSubtotal: "40" }),
    );
    expect(fields.value).toBe("1250");
    expect(fields.currency).toBe("EUR");
    expect(fields.min_subtotal_amount).toBe(4000);
  });

  it("sends 0 for an unreadable fixed amount and null for a blank currency", () => {
    const fields = draftToFields(draft({ type: "fixed_amount", value: "", currency: "  " }));
    expect(fields.value).toBe("0");
    expect(fields.currency).toBeNull();
  });

  it("sends 0 as the value of free shipping, whatever was typed", () => {
    expect(draftToFields(draft({ type: "free_shipping", value: "30" })).value).toBe("0");
  });

  it("sends target ids only when the discount is scoped", () => {
    const targets = [
      { id: "p1", label: "A" },
      { id: "p2", label: "B" },
    ];
    expect(draftToFields(draft({ appliesTo: "products", targets })).target_ids).toEqual([
      "p1",
      "p2",
    ]);
    expect(draftToFields(draft({ appliesTo: "all", targets })).target_ids).toBeNull();
  });

  it("sends whole-number limits and drops fractions", () => {
    const fields = draftToFields(draft({ maxRedemptions: "10", maxPerCustomer: "1.5" }));
    expect(fields.max_redemptions).toBe(10);
    expect(fields.max_per_customer).toBeNull();
  });

  it("sends buy/get quantities only for buy X get Y", () => {
    const bxgy = draftToFields(
      draft({ type: "buy_x_get_y", value: "100", buyQuantity: "2", getQuantity: "1" }),
    );
    expect(bxgy.buy_quantity).toBe(2);
    expect(bxgy.get_quantity).toBe(1);
    const pct = draftToFields(draft({ buyQuantity: "2", getQuantity: "1" }));
    expect(pct.buy_quantity).toBeNull();
    expect(pct.get_quantity).toBeNull();
  });

  it("converts local dates to instants and ignores unreadable ones", () => {
    const fields = draftToFields(draft({ startsAt: "2026-04-01T10:30", endsAt: "nonsense" }));
    expect(fields.starts_at).toBe(new Date("2026-04-01T10:30").toISOString());
    expect(fields.ends_at).toBeNull();
  });
});

describe("changedFields", () => {
  it("is empty when nothing changed", () => {
    const before = draft({ title: "Spring", value: "20" });
    expect(changedFields(before, { ...before })).toEqual({});
  });

  it("returns only the fields that differ", () => {
    const before = draft({ title: "Spring", value: "20", code: "A" });
    const after = { ...before, title: "Summer", maxRedemptions: "5" };
    expect(changedFields(before, after)).toEqual({ title: "Summer", max_redemptions: 5 });
  });

  it("never clears the start date because the field was blanked", () => {
    const before = draft({ startsAt: "2026-04-01T10:30" });
    expect(changedFields(before, { ...before, startsAt: "" })).toEqual({});
  });

  it("sends a new start date", () => {
    const before = draft({ startsAt: "2026-04-01T10:30" });
    expect(changedFields(before, { ...before, startsAt: "2026-05-01T10:30" })).toEqual({
      starts_at: new Date("2026-05-01T10:30").toISOString(),
    });
  });
});

describe("describeDraft", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 1, 12, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads a blank draft with placeholders", () => {
    expect(describeDraft(draft())).toBe(
      "…% off everything, applied automatically, no code needed, does not combine with other discounts.",
    );
  });

  it("reads a full percentage rule in order", () => {
    expect(
      describeDraft(
        draft({
          value: "20",
          code: "spring20",
          segment: "returning",
          firstOrderOnly: true,
          minSubtotal: "50",
          maxRedemptions: "1",
          maxPerCustomer: "1",
          stackable: true,
        }),
      ),
    ).toBe(
      "20% off everything, with code SPRING20, for returning customers, for a customer's first order, on orders of $50.00 or more, limited to 1 use, once per customer, combines with other discounts.",
    );
  });

  it("pluralises uses and counts per-customer limits", () => {
    const sentence = describeDraft(
      draft({ value: "10", maxRedemptions: "5", maxPerCustomer: "3", segment: "subscribers" }),
    );
    expect(sentence).toContain("for newsletter subscribers");
    expect(sentence).toContain("limited to 5 uses");
    expect(sentence).toContain("up to 3 times per customer");
  });

  it("names the staff segment", () => {
    expect(describeDraft(draft({ segment: "staff" }))).toContain("for staff only");
  });

  it("formats a fixed amount in its currency", () => {
    expect(describeDraft(draft({ type: "fixed_amount", value: "10", currency: "EUR" }))).toMatch(
      /^€10\.00 off everything/,
    );
  });

  it("falls back to plain text when the amount or currency cannot be formatted", () => {
    expect(describeDraft(draft({ type: "fixed_amount", value: "abc" }))).toMatch(
      /^abc USD off everything/,
    );
    expect(describeDraft(draft({ type: "fixed_amount", value: "10", currency: "ZZ" }))).toMatch(
      /^10\.00 ZZ off everything/,
    );
    expect(describeDraft(draft({ type: "fixed_amount", value: "10", currency: "" }))).toMatch(
      /^\$10\.00 off everything/,
    );
  });

  it("lists chosen products, and summarises long lists", () => {
    const names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];
    const targets = names.map((label, index) => ({ id: String(index), label }));
    const scoped = (count: number) =>
      describeDraft(draft({ value: "5", appliesTo: "products", targets: targets.slice(0, count) }));
    expect(scoped(0)).toMatch(/^5% off the chosen products,/);
    expect(scoped(1)).toMatch(/^5% off Alpha,/);
    expect(scoped(2)).toMatch(/^5% off Alpha and Bravo,/);
    expect(scoped(3)).toMatch(/^5% off Alpha, Bravo and Charlie,/);
    expect(scoped(5)).toMatch(/^5% off Alpha, Bravo and 3 more products,/);
  });

  it("reads collections as everything in them", () => {
    expect(describeDraft(draft({ value: "5", appliesTo: "collections" }))).toMatch(
      /^5% off the chosen collections,/,
    );
    expect(
      describeDraft(
        draft({ value: "5", appliesTo: "collections", targets: [{ id: "k", label: "Summer" }] }),
      ),
    ).toMatch(/^5% off everything in Summer,/);
  });

  it("reads free shipping on the whole order or when items are included", () => {
    expect(describeDraft(draft({ type: "free_shipping" }))).toMatch(
      /^Free shipping on the whole order,/,
    );
    expect(
      describeDraft(
        draft({
          type: "free_shipping",
          appliesTo: "products",
          targets: [{ id: "p", label: "Tent" }],
        }),
      ),
    ).toMatch(/^Free shipping when the order includes Tent,/);
  });

  it("reads buy X get Y as free or as a percent off, with its scope", () => {
    expect(
      describeDraft(
        draft({ type: "buy_x_get_y", value: "100", buyQuantity: "2", getQuantity: "1" }),
      ),
    ).toMatch(/^Buy 2, get 1 free \(the cheapest items are discounted\),/);
    expect(
      describeDraft(
        draft({
          type: "buy_x_get_y",
          value: "50",
          appliesTo: "collections",
          targets: [{ id: "k", label: "Socks" }],
        }),
      ),
    ).toMatch(/^Buy …, get … 50% off from everything in Socks \(the cheapest/);
  });

  it("ignores a minimum it cannot read", () => {
    expect(describeDraft(draft({ value: "5", minSubtotal: "abc" }))).not.toContain("on orders");
  });

  it("says when a future rule starts and ends", () => {
    const sentence = describeDraft(
      draft({ value: "5", startsAt: "2026-07-01T09:00", endsAt: "2026-07-31T09:00" }),
    );
    expect(sentence).toContain(
      `from ${short("2026-07-01T09:00")} until ${short("2026-07-31T09:00")}.`,
    );
  });

  it("says only the start of an open-ended future rule", () => {
    expect(describeDraft(draft({ value: "5", startsAt: "2026-07-01T09:00" }))).toContain(
      `from ${short("2026-07-01T09:00")}.`,
    );
  });

  it("drops a start in the past, and shows the year of an end in another year", () => {
    const sentence = describeDraft(
      draft({ value: "5", startsAt: "2026-01-01T09:00", endsAt: "2027-02-01T09:00" }),
    );
    expect(sentence).not.toContain("from ");
    expect(sentence).toContain(`until ${short("2027-02-01T09:00", true)}.`);
  });

  it("prefixes a switched-off rule", () => {
    expect(describeDraft(draft({ value: "20", isActive: false }))).toMatch(
      /^Switched off — 20% off everything/,
    );
    expect(describeDraft(draft({ type: "free_shipping", isActive: false }))).toMatch(
      /^Switched off — free shipping/,
    );
  });
});

describe("workedExample", () => {
  it("works a percentage through a $100 order", () => {
    expect(workedExample(draft({ value: "20" }))).toBe(
      "Example: an order of $100.00 pays $80.00 before shipping and tax.",
    );
  });

  it("raises the sample order above the minimum", () => {
    expect(workedExample(draft({ value: "20", minSubtotal: "200" }))).toBe(
      "Example: an order of $300.00 pays $240.00 before shipping and tax.",
    );
  });

  it("never takes a fixed amount below zero", () => {
    expect(workedExample(draft({ type: "fixed_amount", value: "500", currency: "" }))).toBe(
      "Example: an order of $100.00 pays $0.00 before shipping and tax.",
    );
  });

  it("has no example for scoped, shipping or buy X get Y rules", () => {
    expect(workedExample(draft({ value: "20", appliesTo: "products" }))).toBeNull();
    expect(workedExample(draft({ type: "free_shipping" }))).toBeNull();
    expect(workedExample(draft({ type: "buy_x_get_y", value: "100" }))).toBeNull();
  });

  it("has no example for a value out of range", () => {
    expect(workedExample(draft({ value: "" }))).toBeNull();
    expect(workedExample(draft({ value: "150" }))).toBeNull();
    expect(workedExample(draft({ type: "fixed_amount", value: "0" }))).toBeNull();
    expect(workedExample(draft({ type: "fixed_amount", value: "x" }))).toBeNull();
  });

  it("has no example when the currency cannot be formatted", () => {
    expect(workedExample(draft({ value: "10", currency: "ZZ" }))).toBeNull();
  });
});

describe("valueLabel", () => {
  it("labels every type for the list", () => {
    expect(valueLabel(discountView({ type: "percentage", value: "12.5000" }))).toBe("12.5% off");
    expect(valueLabel(discountView({ type: "fixed_amount", value: "1000", currency: "USD" }))).toBe(
      "$10.00 off",
    );
    expect(valueLabel(discountView({ type: "fixed_amount", value: "1000", currency: null }))).toBe(
      "$10.00 off",
    );
    expect(valueLabel(discountView({ type: "free_shipping" }))).toBe("Free shipping");
    expect(
      valueLabel(
        discountView({ type: "buy_x_get_y", value: "100", buy_quantity: 2, get_quantity: 1 }),
      ),
    ).toBe("Buy 2 get 1 free");
    expect(valueLabel(discountView({ type: "buy_x_get_y", value: "50.0000" }))).toBe(
      "Buy ? get ? at 50% off",
    );
    expect(valueLabel(discountView({ type: "mystery" }))).toBe("mystery");
  });

  it("falls back to the raw value when the currency is unknown", () => {
    expect(valueLabel(discountView({ type: "fixed_amount", value: "1000", currency: "ZZ" }))).toBe(
      "1000 off",
    );
  });
});

describe("generateCode", () => {
  it("makes eight characters with no 0, O, 1 or I", () => {
    for (let index = 0; index < 20; index += 1) {
      expect(generateCode()).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    }
  });
});

describe("lookup tables", () => {
  it("label and tone every status, and explain every cart problem", () => {
    expect(STATUS_LABEL.used_up).toBe("Used up");
    expect(STATUS_TONE.active).toBe("success");
    expect(CART_PROBLEMS["min_subtotal"]).toMatch(/minimum order amount/);
  });
});
