import { describe, expect, it } from "vitest";

import {
  SHIRT_ID,
  TOTE_ID,
  adminOrder,
  adminRefund,
  orderLine,
  toteLine,
  usd,
} from "@/test/fixtures/orders";

import {
  addressLines,
  carrierLabel,
  customerName,
  extraRefunded,
  lineShare,
  previewRefund,
  refundLedger,
  refundableUnits,
  shippingLeft,
  shippingShare,
  unshippedUnits,
} from "./order-math";

describe("lineShare", () => {
  it("never loses a cent when a line is refunded unit by unit", () => {
    const parts = [0, 1, 2].map((already) => lineShare(1000, 3, already, 1));
    expect(parts).toEqual([333, 333, 334]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it("matches refunding everything at once", () => {
    expect(lineShare(1000, 3, 0, 3)).toBe(1000);
    expect(lineShare(1000, 3, 1, 2)).toBe(667);
  });

  it("is zero for nothing, and stops at the quantity", () => {
    expect(lineShare(1000, 3, 0, 0)).toBe(0);
    expect(lineShare(1000, 3, 2, 5)).toBe(334);
  });

  it("is zero for an empty line and clamps a nonsense ledger", () => {
    expect(lineShare(1000, 0, 0, 1)).toBe(0);
    expect(lineShare(1000, 3, -2, 1)).toBe(333);
    expect(lineShare(1000, 3, 9, 1)).toBe(0);
  });
});

describe("the refund ledger", () => {
  const order = adminOrder({
    admin_refunds: [
      adminRefund({
        amount: usd(1700),
        lines: [{ order_item_id: SHIRT_ID, quantity: 1, amount: 1000, restock: true }],
      }),
      adminRefund({
        id: "r2",
        status: "pending",
        amount: usd(1500),
        lines: [{ order_item_id: TOTE_ID, quantity: 1, amount: 1500 }],
      }),
      adminRefund({
        id: "r3",
        status: "failed",
        amount: usd(3000),
        lines: [{ order_item_id: SHIRT_ID }],
      }),
      adminRefund({ id: "r4", status: "cancelled", amount: usd(300), lines: [] }),
    ],
  });

  it("counts committed refunds per line, and which of them were restocked", () => {
    const ledger = refundLedger(order);
    expect(ledger.get(SHIRT_ID)).toEqual({ refunded: 1, removed: 1 });
    expect(ledger.get(TOTE_ID)).toEqual({ refunded: 1, removed: 0 });
  });

  it("treats a line entry without a quantity as nothing", () => {
    const ledger = refundLedger(
      adminOrder({ admin_refunds: [adminRefund({ lines: [{ order_item_id: SHIRT_ID }] })] }),
    );
    expect(ledger.get(SHIRT_ID)).toEqual({ refunded: 0, removed: 0 });
  });

  it("finds money refunded beyond the lines", () => {
    expect(extraRefunded(order)).toBe(700);
    expect(extraRefunded(adminOrder({ admin_refunds: [adminRefund({ lines: [{}] })] }))).toBe(1000);
  });

  it("knows what shipping was charged and what is left of it", () => {
    expect(shippingShare(order)).toBe(500);
    expect(shippingLeft(order)).toBe(0);
    expect(shippingLeft(adminOrder())).toBe(500);
    expect(shippingShare(adminOrder({ totals: { ...adminOrder().totals, total: usd(100) } }))).toBe(
      0,
    );
  });

  it("knows how many units are left to refund and to ship", () => {
    const ledger = refundLedger(order);
    const shirt = orderLine({ quantity_fulfilled: 1 });
    expect(refundableUnits(shirt, ledger)).toBe(2);
    expect(unshippedUnits(shirt, ledger)).toBe(1);
    expect(refundableUnits(toteLine(), ledger)).toBe(0);
    expect(unshippedUnits(toteLine(), ledger)).toBe(0);
    expect(refundableUnits(orderLine({ id: "unknown" }), ledger)).toBe(3);
  });
});

describe("previewRefund", () => {
  it("adds lines, shipping and goodwill, and flags more than is refundable", () => {
    const preview = previewRefund(adminOrder(), {
      lines: [
        { id: SHIRT_ID, quantity: 2 },
        { id: "unknown", quantity: 1 },
        { id: TOTE_ID, quantity: 0 },
      ],
      includeShipping: true,
      extra: 250,
    });
    expect(preview).toEqual({
      lines: 2000,
      shipping: 500,
      extra: 250,
      total: 2750,
      refundable: 5000,
      exceeds: false,
    });
  });

  it("never counts negative goodwill and catches an over-refund", () => {
    const preview = previewRefund(adminOrder({ refundable: usd(1000) }), {
      lines: [{ id: SHIRT_ID, quantity: 3 }],
      includeShipping: false,
      extra: -500,
    });
    expect(preview.extra).toBe(0);
    expect(preview.total).toBe(3000);
    expect(preview.exceeds).toBe(true);
  });
});

describe("addresses and names", () => {
  it("prints an address as lines, skipping blanks and non-strings", () => {
    expect(
      addressLines({
        first_name: "Ada",
        last_name: "Lovelace",
        company: "",
        line1: "1 Analytical Way",
        line2: 42,
        city: "London",
        region: null,
        postal_code: "N1 1AA",
        country_code: "GB",
        phone: "+44 20 0000 0000",
      }),
    ).toEqual(["Ada Lovelace", "1 Analytical Way", "London, N1 1AA", "GB", "+44 20 0000 0000"]);
    expect(addressLines({})).toEqual([]);
  });

  it("names the customer from the shipping address, or not at all", () => {
    expect(customerName(adminOrder())).toBe("Ada Lovelace");
    expect(customerName(adminOrder({ shipping_address: { first_name: "Ada" } }))).toBe("Ada");
    expect(customerName(adminOrder({ shipping_address: { first_name: 7 } }))).toBeNull();
  });
});

describe("carrierLabel", () => {
  it("labels known carriers and passes others through", () => {
    expect(carrierLabel("royal_mail")).toBe("Royal Mail");
    expect(carrierLabel("Pigeon Post")).toBe("Pigeon Post");
    expect(carrierLabel(null)).toBe("Carrier");
    expect(carrierLabel(undefined)).toBe("Carrier");
  });
});
