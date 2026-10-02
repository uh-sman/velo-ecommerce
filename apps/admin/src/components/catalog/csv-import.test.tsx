import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CsvImport } from "@/components/catalog/csv-import";
import { MAX_IMPORT_BYTES } from "@/components/catalog/csv";
import { importReport, spyOnToasts } from "@/test/fixtures/catalog-lists";
import { fail, offline, on, server } from "@/test/server";

const IMPORT = "/api/v1/admin/products/bulk-import";

const GOOD_CSV = [
  "Product Slug,SKU,price,title,notes",
  "runner,RUN-1,29.99,Trail Runner,first",
  "runner,RUN-2,31.00,Trail Runner,",
  "",
  "cap,CAP-1,9.50,Cap,x",
].join("\n");

function csvFile(text: string, name = "catalog.csv") {
  const file = new File([text], name, { type: "text/csv" });
  // jsdom's Blob has no text(); every browser the admin supports does.
  Object.defineProperty(file, "text", { value: () => Promise.resolve(text) });
  return file;
}

async function upload(text = GOOD_CSV, name = "catalog.csv") {
  const user = userEvent.setup();
  render(<CsvImport />);
  await user.upload(screen.getByLabelText("CSV file"), csvFile(text, name));
  return user;
}

interface Sent {
  dryRun: string | null;
  body: string;
  contentType: string | null;
  csrf: string | null;
}

/** Answers the import with `reports` in order (the last one repeats) and records each request. */
function importHandler(...reports: ReturnType<typeof importReport>[]) {
  const sent: Sent[] = [];
  server.use(
    on("post", IMPORT, async ({ request }) => {
      sent.push({
        dryRun: new URL(request.url).searchParams.get("dry_run"),
        body: await request.text(),
        contentType: request.headers.get("Content-Type"),
        csrf: request.headers.get("X-CSRF-Token"),
      });
      const report = reports[Math.min(sent.length - 1, reports.length - 1)];
      return HttpResponse.json(report);
    }),
  );
  return sent;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CsvImport", () => {
  it("parses the file, guesses the mapping and lists the columns it will not send", async () => {
    await upload();
    expect(screen.getByText("catalog.csv")).toBeInTheDocument();
    // The blank line is skipped, as the API skips it.
    expect(screen.getByText(/3 rows, 5 columns/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose another file" })).toBeInTheDocument();

    const table = screen.getByRole("table", { name: "Column mapping" });
    expect(within(table).getByLabelText("product_slug")).toHaveDisplayValue("Product Slug");
    expect(within(table).getByLabelText("sku")).toHaveDisplayValue("SKU");
    expect(within(table).getByLabelText("price")).toHaveDisplayValue("price");
    expect(within(table).getByLabelText("brand")).toHaveDisplayValue("Not imported");
    expect(within(table).getByLabelText("price")).not.toHaveAttribute("aria-invalid");
    // The first row's value previews each mapped column.
    expect(within(table).getByText("29.99")).toBeInTheDocument();
    expect(screen.getByText("Not sent: notes.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check the file" })).toBeEnabled();
  });

  it("checks with a dry run, then imports the rebuilt file", async () => {
    const toasts = spyOnToasts();
    const sent = importHandler(importReport(), importReport({ applied: true, dry_run: false }));
    const user = await upload();

    await user.click(screen.getByRole("button", { name: "Check the file" }));
    expect(await screen.findByText("No problems in 3 rows. Ready to import.")).toBeInTheDocument();
    expect(sent[0]).toEqual({
      dryRun: "true",
      body:
        "product_slug,title,sku,price\n" +
        "runner,Trail Runner,RUN-1,29.99\n" +
        "runner,Trail Runner,RUN-2,31.00\n" +
        "cap,Cap,CAP-1,9.50\n",
      contentType: "text/csv; charset=utf-8",
      csrf: "test-csrf",
    });
    expect(screen.getByText("Products created").nextSibling).toHaveTextContent("1");
    expect(screen.getByText("Variants updated").nextSibling).toHaveTextContent("5");

    await user.click(screen.getByRole("button", { name: "Import 3 rows" }));
    expect(await screen.findByText("Imported 3 rows")).toBeInTheDocument();
    expect(sent[1]?.dryRun).toBe("false");
    expect(sent[1]?.body).toBe(sent[0]?.body);
    expect(toasts.success).toHaveBeenCalledWith("Catalog imported");
    expect(screen.getByRole("link", { name: "Go to products" })).toHaveAttribute(
      "href",
      "/products",
    );

    await user.click(screen.getByRole("button", { name: "Import another file" }));
    expect(screen.getByRole("button", { name: "Choose a CSV file" })).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Column mapping" })).not.toBeInTheDocument();
  });

  it("blocks the check until every required column is mapped", async () => {
    const user = await upload("handle,code\nrunner,RUN-1\n");
    const check = screen.getByRole("button", { name: "Check the file" });
    expect(check).toBeDisabled();
    expect(screen.getByText("Choose a column for: product_slug, sku, price.")).toBeInTheDocument();
    expect(screen.getByLabelText("sku")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Not sent: handle, code.")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("product_slug"), "handle");
    await user.selectOptions(screen.getByLabelText("sku"), "code");
    expect(screen.getByText("Choose a column for: price.")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("price"), "code");
    expect(check).toBeEnabled();
    expect(screen.queryByText(/Not sent/)).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("price"), "Not imported");
    expect(check).toBeDisabled();
    expect(screen.getByLabelText("price")).toHaveAttribute("aria-invalid", "true");
  });

  it("names a column without a header by its position", async () => {
    await upload("sku,,price,product_slug\nA,ignored,1,a\n");
    expect(
      within(screen.getByLabelText("title")).getByRole("option", {
        name: "Column 2 (no header)",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Not sent: (no header).")).toBeInTheDocument();
  });

  it("lists every dry-run problem by row and column with the offending cell", async () => {
    importHandler(
      importReport({
        rows: 3,
        errors: [
          { row: 4, column: "price", message: "Not a number." },
          { row: 2, column: "sku", message: "Already used by another product." },
          { row: 3, column: null, message: "Duplicate row." },
          { row: 3, column: "brand", message: "Unknown brand." },
          { row: 3, column: "mystery", message: "Unknown column." },
        ],
      }),
    );
    const user = await upload();
    await user.click(screen.getByRole("button", { name: "Check the file" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "5 problems in 3 rows — nothing will be imported until they are fixed",
    );
    const table = screen.getByRole("table", { name: "Import problems" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell")[0]?.textContent)).toEqual([
      "2",
      "3",
      "3",
      "3",
      "4",
    ]);
    // Row 2 is the first record: its sku cell as the operator typed it.
    expect(rows[0]).toHaveTextContent("skuRUN-1Already used by another product.");
    expect(rows[1]).toHaveTextContent("——Duplicate row.");
    expect(rows[2]).toHaveTextContent("brand—Unknown brand.");
    expect(rows[3]).toHaveTextContent("mystery—Unknown column.");
    expect(rows[4]).toHaveTextContent("price9.50Not a number.");
    expect(screen.queryByRole("button", { name: /^Import/ })).not.toBeInTheDocument();
  });

  it("uses the singular for a single problem", async () => {
    importHandler(importReport({ rows: 1, errors: [{ row: 9, column: "sku", message: "Bad." }] }));
    const user = await upload();
    await user.click(screen.getByRole("button", { name: "Check the file" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/^1 problem in 1 rows/);
    // A row number past the end of the file has no cell to show.
    expect(screen.getByRole("table", { name: "Import problems" })).toHaveTextContent("9sku—Bad.");
  });

  it("clears the dry-run result when the mapping changes", async () => {
    importHandler(importReport());
    const user = await upload();
    await user.click(screen.getByRole("button", { name: "Check the file" }));
    expect(await screen.findByText(/Ready to import/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("brand"), "notes");
    expect(screen.queryByText(/Ready to import/)).not.toBeInTheDocument();
  });

  it("shows the API's problem when the file is refused", async () => {
    server.use(
      fail("post", IMPORT, {
        status: 413,
        slug: "too-large",
        title: "Too large",
        detail: "At most 10,000 rows.",
      }),
    );
    const user = await upload();
    await user.click(screen.getByRole("button", { name: "Check the file" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The file was refused: At most 10,000 rows.",
    );
  });

  it("falls back to a generic message for an error without a problem body", async () => {
    server.use(on("post", IMPORT, () => new HttpResponse("upstream timeout", { status: 502 })));
    const user = await upload();
    await user.click(screen.getByRole("button", { name: "Check the file" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The file was refused: Please try again.",
    );
  });

  it("explains a network failure", async () => {
    server.use(offline("post", IMPORT));
    const user = await upload();
    await user.click(screen.getByRole("button", { name: "Check the file" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The file was refused: Check your connection and try again.",
    );
  });

  it("reports an import that the API refuses outright", async () => {
    const toasts = spyOnToasts();
    let calls = 0;
    server.use(
      on("post", IMPORT, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json(importReport())
          : HttpResponse.json(
              { type: "https://velo.dev/errors/conflict", title: "Conflict", status: 409 },
              { status: 409 },
            );
      }),
    );
    const user = await upload();
    await user.click(screen.getByRole("button", { name: "Check the file" }));
    await user.click(await screen.findByRole("button", { name: "Import 3 rows" }));
    expect(await screen.findByText("The file was refused: Conflict")).toBeInTheDocument();
    expect(toasts.error).toHaveBeenCalledWith("Nothing was imported");
    expect(screen.queryByText(/Imported/)).not.toBeInTheDocument();
  });

  it("shows new problems when the catalog changed between the dry run and the import", async () => {
    const toasts = spyOnToasts();
    importHandler(
      importReport(),
      importReport({
        dry_run: false,
        applied: false,
        errors: [{ row: 2, column: "sku", message: "Taken since the check." }],
      }),
    );
    const user = await upload();
    await user.click(screen.getByRole("button", { name: "Check the file" }));
    await user.click(await screen.findByRole("button", { name: "Import 3 rows" }));
    expect(await screen.findByText(/Taken since the check\./)).toBeInTheDocument();
    expect(toasts.error).toHaveBeenCalledWith("Nothing was imported — see the problems below");
  });

  it("refuses a file over 5 MB without reading it", async () => {
    const user = userEvent.setup();
    render(<CsvImport />);
    const big = csvFile("sku,price\nA,1\n", "huge.csv");
    Object.defineProperty(big, "size", { value: MAX_IMPORT_BYTES + 1 });
    await user.upload(screen.getByLabelText("CSV file"), big);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The file is larger than 5 MB. Split it and import the parts one at a time.",
    );
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("needs a header row and at least one product row", async () => {
    await upload("sku,price\n\n");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The file needs a header row and at least one product row.",
    );
  });

  it("refuses an empty file", async () => {
    await upload("", "empty.csv");
    expect(await screen.findByRole("alert")).toHaveTextContent(/needs a header row/);
  });

  it("starts over when the picker is dismissed without a file", async () => {
    await upload();
    expect(screen.getByRole("table", { name: "Column mapping" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("CSV file"), { target: { files: [] } });
    await waitFor(() => {
      expect(screen.queryByRole("table", { name: "Column mapping" })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Choose a CSV file" })).toBeInTheDocument();
  });

  it("opens the file picker from the visible button", async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    const user = userEvent.setup();
    render(<CsvImport />);
    await user.click(screen.getByRole("button", { name: "Choose a CSV file" }));
    expect(click).toHaveBeenCalledTimes(1);
  });
});
