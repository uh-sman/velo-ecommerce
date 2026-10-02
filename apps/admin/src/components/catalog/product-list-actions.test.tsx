import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExportButton, ProductListActions } from "@/components/catalog/product-list-actions";
import { spyOnToasts } from "@/test/fixtures/catalog-lists";
import { renderWithMe, staff } from "@/test/render";
import { fail, offline, on, server } from "@/test/server";

const EXPORT = "/api/v1/admin/products/export";

/** What the browser was asked to save: jsdom can neither make blob URLs nor download. */
let saved: { filename: string; href: string }[] = [];

beforeEach(() => {
  saved = [];
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn(() => "blob:velo/export"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved.push({ filename: this.download, href: this.href });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ProductListActions", () => {
  it("offers export, import and a new product to catalog writers", () => {
    renderWithMe(<ProductListActions />);
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Import CSV" })).toHaveAttribute(
      "href",
      "/products/import",
    );
    expect(screen.getByRole("link", { name: "New product" })).toHaveAttribute(
      "href",
      "/products/new",
    );
  });

  it("offers only the export to staff who cannot write the catalog", () => {
    renderWithMe(<ProductListActions />, {
      me: staff({ role: "support", permissions: ["admin:access", "orders:read"] }),
    });
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Import CSV" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "New product" })).not.toBeInTheDocument();
  });
});

describe("ExportButton", () => {
  it("downloads the export under the name the API gives it", async () => {
    const toasts = spyOnToasts();
    let csrf: string | null = null;
    server.use(
      on("get", EXPORT, ({ request }) => {
        csrf = request.headers.get("X-CSRF-Token");
        return new HttpResponse("product_slug,sku\n", {
          headers: {
            "Content-Type": "text/csv",
            "Content-Disposition": 'attachment; filename="velo-catalog-2026-10-02.csv"',
          },
        });
      }),
    );
    const user = userEvent.setup();
    renderWithMe(<ExportButton label="Download catalog" />);
    await user.click(screen.getByRole("button", { name: "Download catalog" }));
    await waitFor(() => {
      expect(toasts.success).toHaveBeenCalledWith("Catalog exported");
    });
    expect(saved).toEqual([{ filename: "velo-catalog-2026-10-02.csv", href: "blob:velo/export" }]);
    expect(csrf).toBe("test-csrf");
    expect(screen.getByRole("button", { name: "Download catalog" })).toBeEnabled();
  });

  it("falls back to a default file name", async () => {
    spyOnToasts();
    server.use(on("get", EXPORT, () => new HttpResponse("sku\n")));
    const user = userEvent.setup();
    renderWithMe(<ExportButton />);
    await user.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => {
      expect(saved).toEqual([{ filename: "velo-catalog.csv", href: "blob:velo/export" }]);
    });
  });

  it("reports the API's problem when the export fails", async () => {
    const toasts = spyOnToasts();
    server.use(fail("get", EXPORT, { status: 403, slug: "forbidden", title: "Not allowed" }));
    const user = userEvent.setup();
    renderWithMe(<ExportButton />);
    await user.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => {
      expect(toasts.error).toHaveBeenCalledWith("Export failed: Not allowed");
    });
    expect(saved).toEqual([]);
  });

  it("reports a network failure", async () => {
    const toasts = spyOnToasts();
    server.use(offline("get", EXPORT));
    const user = userEvent.setup();
    renderWithMe(<ExportButton />);
    await user.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => {
      expect(toasts.error).toHaveBeenCalledWith(
        "Export failed: Check your connection and try again.",
      );
    });
  });
});
