import { describe, expect, it } from "vitest";

import {
  guessMapping,
  IMPORT_COLUMNS,
  normaliseHeader,
  parseCsv,
  rebuild,
  toCsv,
  type ImportColumn,
} from "@/components/catalog/csv";

function emptyMapping(): Record<ImportColumn, number | null> {
  const mapping = {} as Record<ImportColumn, number | null>;
  for (const column of IMPORT_COLUMNS) mapping[column] = null;
  return mapping;
}

describe("parseCsv", () => {
  it("splits plain rows and fields", () => {
    expect(parseCsv("a,b,c\n1,2,3\n")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("keeps the last row when the file has no trailing newline", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps a trailing empty field after a final comma", () => {
    expect(parseCsv("a,")).toEqual([["a", ""]]);
  });

  it("reads quoted fields with commas, doubled quotes and line breaks", () => {
    expect(parseCsv('name,note\n"Smith, Ada","She said ""hi""\nthen left"\n')).toEqual([
      ["name", "note"],
      ["Smith, Ada", 'She said "hi"\nthen left'],
    ]);
  });

  it("treats CRLF, LF and a lone CR as row breaks", () => {
    expect(parseCsv("a\r\nb\nc\rd")).toEqual([["a"], ["b"], ["c"], ["d"]]);
  });

  it("strips the byte-order mark Excel writes", () => {
    expect(parseCsv("﻿sku,price\nA,1\n")).toEqual([
      ["sku", "price"],
      ["A", "1"],
    ]);
  });

  it("returns blank lines as a single empty field and nothing for empty input", () => {
    expect(parseCsv("a\n\nb\n")).toEqual([["a"], [""], ["b"]]);
    expect(parseCsv("")).toEqual([]);
  });
});

describe("toCsv", () => {
  it("quotes only the fields that need it", () => {
    expect(
      toCsv([
        ["plain", "with,comma", 'say "hi"', "line\nbreak", " padded ", "cr\r"],
        ["", "x"],
      ]),
    ).toBe('plain,"with,comma","say ""hi""","line\nbreak"," padded ","cr\r"\n,x\n');
  });

  it("round-trips through parseCsv", () => {
    const rows = [
      ["sku", "title"],
      ["A-1", 'Shoe, "fast"\nedition'],
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});

describe("normaliseHeader", () => {
  it("lower-cases, trims and turns spaces and hyphens into underscores", () => {
    expect(normaliseHeader("  Product Slug ")).toBe("product_slug");
    expect(normaliseHeader("product-slug")).toBe("product_slug");
    expect(normaliseHeader("Compare  At")).toBe("compare_at");
  });
});

describe("guessMapping", () => {
  it("prefers an exact header over a loose one and leaves the rest unmapped", () => {
    const mapping = guessMapping(["Price", "SKU", "price", "Product Slug", "notes"]);
    expect(mapping.price).toBe(2);
    expect(mapping.sku).toBe(1);
    expect(mapping.product_slug).toBe(3);
    expect(mapping.title).toBeNull();
    expect(Object.keys(mapping)).toEqual([...IMPORT_COLUMNS]);
  });

  it("matches a header with surrounding spaces exactly", () => {
    expect(guessMapping([" sku "]).sku).toBe(0);
  });
});

describe("rebuild", () => {
  it("writes the expected headers in export order with only mapped columns", () => {
    const mapping = { ...emptyMapping(), sku: 0, product_slug: 2, price: 1 };
    const csv = rebuild(
      [
        ["A-1", "9.99", "shoe"],
        ["A-2", "19.99"],
      ],
      mapping,
    );
    expect(csv).toBe("product_slug,sku,price\nshoe,A-1,9.99\n,A-2,19.99\n");
  });

  it("writes just the header row when nothing is mapped", () => {
    expect(rebuild([["x"]], emptyMapping())).toBe("\n\n");
  });
});
