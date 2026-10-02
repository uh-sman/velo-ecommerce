/*
 * Just enough CSV for the import's column mapping: RFC 4180 parsing (quoted
 * fields, doubled quotes, line breaks inside quotes, CRLF or LF, a leading
 * BOM from Excel) and the matching writer. The API re-parses what is sent
 * and remains the authority on every cell.
 */

/** The columns `GET /admin/products/export` writes, in its order (apps/api csv_io.COLUMNS). */
export const IMPORT_COLUMNS = [
  "product_slug",
  "title",
  "subtitle",
  "brand",
  "status",
  "category",
  "collections",
  "description",
  "seo_title",
  "seo_description",
  "sku",
  "variant_title",
  "option1_name",
  "option1_value",
  "option2_name",
  "option2_value",
  "option3_name",
  "option3_value",
  "price",
  "compare_at",
  "cost",
  "currency",
  "weight_grams",
  "barcode",
  "stock",
  "reorder_point",
] as const;

export type ImportColumn = (typeof IMPORT_COLUMNS)[number];

/** A row cannot be imported without these (csv_io.REQUIRED). */
export const REQUIRED_COLUMNS: readonly ImportColumn[] = ["product_slug", "sku", "price"];

export const COLUMN_HINT: Partial<Record<ImportColumn, string>> = {
  product_slug: "Groups rows into one product; matches existing products.",
  title: "Required for a new product.",
  status: "draft, active or archived.",
  category: "A category's URL handle.",
  collections: "Collection handles separated by |.",
  sku: "Matches existing variants.",
  price: "A plain amount, such as 29.99.",
  compare_at: "Must be higher than the price.",
  currency: "Three letters, such as USD.",
  stock: "Opening stock — new variants only.",
};

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export function parseCsv(text: string): string[][] {
  const source = text.startsWith("﻿") ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function quote(value: string): string {
  return /[",\r\n]/.test(value) || value !== value.trim()
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}

export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(quote).join(",")).join("\n") + "\n";
}

/** "Product Slug", "product-slug", " product_slug " all read as `product_slug`. */
export function normaliseHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

/**
 * For each import column, the index of the file's header that feeds it, or
 * null. Exact matches first, then the same name in another case or spacing.
 */
export function guessMapping(headers: readonly string[]): Record<ImportColumn, number | null> {
  const mapping = {} as Record<ImportColumn, number | null>;
  for (const column of IMPORT_COLUMNS) {
    const exact = headers.findIndex((header) => header.trim() === column);
    const loose = headers.findIndex((header) => normaliseHeader(header) === column);
    mapping[column] = exact >= 0 ? exact : loose >= 0 ? loose : null;
  }
  return mapping;
}

/** The file rebuilt with the expected headers, mapped columns only, rows in the same order. */
export function rebuild(
  records: readonly (readonly string[])[],
  mapping: Record<ImportColumn, number | null>,
): string {
  const columns = IMPORT_COLUMNS.filter((column) => mapping[column] !== null);
  const body = records.map((record) =>
    columns.map((column) => {
      const index = mapping[column];
      return index === null ? "" : (record[index] ?? "");
    }),
  );
  return toCsv([columns, ...body]);
}
