import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Schema } from "@velo/api-client";
import { HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProductEditor } from "@/components/catalog/product-editor";
import {
  CATEGORIES,
  COLLECTIONS,
  PRODUCT_ID,
  productView,
  VARIANT_ID,
  VARIANT_ID_2,
  variantView,
} from "@/test/fixtures/catalog-editor";
import { router } from "@/test/navigation";
import { renderWithMe, staff } from "@/test/render";
import { fail, ok, on, server } from "@/test/server";

type Product = Schema<"AdminProductView">;

const toasts = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  toast: toasts,
}));

async function toasted(kind: keyof typeof toasts, message: string) {
  await waitFor(() => {
    expect(toasts[kind]).toHaveBeenCalledWith(message, expect.anything());
  });
}

// Typing into a large controlled form is slow in jsdom; leave room on a busy machine.
vi.setConfig({ testTimeout: 45_000 });

const PRODUCT_PATH = "/api/v1/admin/products/{product_id}" as const;

function serveProduct(product: Product) {
  server.use(ok("get", PRODUCT_PATH, product));
}

async function renderExisting(product: Product = productView(), me = staff()) {
  serveProduct(product);
  const view = renderWithMe(<ProductEditor productId={product.id} />, { me });
  await screen.findByRole("heading", { level: 1, name: product.title });
  return view;
}

function saveBar() {
  return screen.getByText(/Unsaved changes|New product$|to fix$/, { selector: "p" });
}

beforeEach(() => {
  for (const fn of Object.values(toasts)) fn.mockReset();
  server.use(
    ok("get", "/api/v1/admin/categories", CATEGORIES),
    ok("get", "/api/v1/admin/collections", COLLECTIONS),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── New product ───────────────────────────────────────────────────────────

describe("ProductEditor — new product", () => {
  it("starts empty, derives the URL handle from the title and previews the search result", async () => {
    const user = userEvent.setup();
    renderWithMe(<ProductEditor productId={null} />);
    expect(screen.getByRole("heading", { level: 1, name: "New product" })).toBeInTheDocument();
    expect(screen.getByText("Saved as a draft until you publish it.")).toBeInTheDocument();
    expect(screen.getByText("Save the product first, then add images.")).toBeInTheDocument();
    expect(saveBar()).toHaveTextContent("New product");
    expect(screen.queryByRole("button", { name: /Publish/ })).not.toBeInTheDocument();

    const preview = screen.getByText("Search result preview").closest("figure") as HTMLElement;
    expect(preview).toHaveTextContent("Product title");
    expect(preview).toHaveTextContent("/products/…");
    expect(preview).toHaveTextContent("Add a meta description, or the store uses the description.");

    await user.type(screen.getByLabelText("Title"), "Linen Tee: Summer!");
    const handle = screen.getByLabelText("URL handle");
    expect(handle).toHaveValue("linen-tee-summer");
    expect(handle).toHaveAccessibleDescription("Made from the title unless you change it.");
    expect(preview).toHaveTextContent("Linen Tee: Summer!");
    expect(preview).toHaveTextContent("/products/linen-tee-summer");

    await user.type(screen.getByLabelText("Description"), "Soft   and\n\ncool.");
    expect(preview).toHaveTextContent("Soft and cool.");
    await user.type(screen.getByLabelText("Page title (optional)"), "Best tee");
    expect(screen.getByLabelText("Page title (optional)")).toHaveAccessibleDescription(
      "8 characters; about 60 show in results.",
    );
    await user.type(screen.getByLabelText("Meta description (optional)"), "Meta.");
    expect(preview).toHaveTextContent("Best tee");
    expect(preview).toHaveTextContent("Meta.");

    // Once the handle is edited by hand it is no longer derived.
    await user.clear(handle);
    expect(handle).toHaveValue("");
    await user.type(handle, "tee");
    await user.type(screen.getByLabelText("Title"), " 2");
    expect(handle).toHaveValue("tee");
  });

  it("validates before sending anything", async () => {
    const user = userEvent.setup();
    renderWithMe(<ProductEditor productId={null} />);
    await user.click(screen.getByRole("button", { name: "Create product" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "1 problem to fix before saving — marked below.",
    );
    expect(screen.getByLabelText("Title")).toHaveAccessibleDescription("Give the product a title.");
    expect(saveBar()).toHaveTextContent("1 problem to fix");
    expect(screen.getByRole("button", { name: "Fix 1 error" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Title"), "Tee");
    await user.type(screen.getByLabelText("URL handle"), "-Bad Slug");
    fireEvent.change(screen.getByLabelText("Meta description (optional)"), {
      target: { value: "x".repeat(321) },
    });
    await user.click(screen.getByRole("button", { name: "Add a variant" }));
    expect(screen.getByLabelText("URL handle")).toHaveAccessibleDescription(
      /Lowercase letters, digits and single hyphens only\./,
    );
    expect(screen.getByLabelText("Meta description (optional)")).toHaveAccessibleDescription(
      /At most 320 characters\./,
    );
    expect(screen.getByRole("textbox", { name: "SKU, Default" })).toHaveAccessibleDescription(
      "Required.",
    );
    expect(screen.getByRole("textbox", { name: "Price, Default" })).toHaveAccessibleDescription(
      "Required.",
    );
    await user.click(screen.getByRole("button", { name: "Fix 4 errors" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "4 problems to fix before saving — marked below.",
    );

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "x".repeat(201) } });
    expect(screen.getByLabelText("Title")).toHaveAccessibleDescription("At most 200 characters.");
  });

  it("creates the product with its variants and organisation, then opens it", async () => {
    const user = userEvent.setup();
    let sent: unknown;
    server.use(
      on("post", "/api/v1/admin/products", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(productView({ id: "new-id", title: "Linen Tee" }), {
          status: 201,
        });
      }),
    );
    renderWithMe(<ProductEditor productId={null} />);
    await user.type(screen.getByLabelText("Title"), "  Linen Tee ");
    await user.type(screen.getByLabelText("Subtitle (optional)"), "Sub");
    await user.type(screen.getByLabelText("Brand (optional)"), "Velo");
    await user.clear(screen.getByLabelText("URL handle"));
    await user.type(screen.getByLabelText("URL handle"), "linen-tee");

    const category = await screen.findByLabelText("Category (optional)");
    expect(
      within(category)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["No category", "Clothing", "Clothing › Tops"]);
    await user.selectOptions(category, "tops");
    expect(screen.getByLabelText("Archive (hidden)")).not.toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "Summer" }));
    await user.click(screen.getByRole("checkbox", { name: "Archive (hidden)" }));
    await user.click(screen.getByRole("checkbox", { name: "Archive (hidden)" }));
    expect(screen.getByRole("checkbox", { name: "Summer" })).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Add a variant" }));
    await user.type(screen.getByRole("textbox", { name: "SKU, Default" }), "LT-1");
    await user.type(screen.getByRole("textbox", { name: "Price, Default" }), "29.99");
    // The second variant starts from the first's prices.
    await user.click(screen.getByRole("button", { name: "Add a variant" }));
    const prices = screen.getAllByRole("textbox", { name: "Price, Default" });
    expect(prices[1]).toHaveValue("29.99");
    await user.click(
      screen.getAllByRole("button", { name: "Remove variant Default" })[1] as HTMLElement,
    );

    await user.click(screen.getByRole("radio", { name: /Archived/ }));
    await user.click(screen.getByRole("radio", { name: /Draft/ }));

    await user.click(screen.getByRole("button", { name: "Create product" }));
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith("/products/new-id");
    });
    await toasted("success", "“Linen Tee” created");
    expect(sent).toEqual({
      title: "Linen Tee",
      status: "draft",
      subtitle: "Sub",
      description: null,
      brand: "Velo",
      category: "tops",
      seo_title: null,
      seo_description: null,
      collections: ["summer"],
      slug: "linen-tee",
      variants: [
        {
          sku: "LT-1",
          price: 2999,
          currency: "USD",
          compare_at: null,
          cost: null,
          barcode: null,
          options: {},
          stock: 0,
          reorder_point: 5,
          track_inventory: true,
          allow_backorder: false,
          requires_shipping: true,
          is_taxable: true,
        },
      ],
    });
  });

  it("maps the API's field errors onto the product and its variants", async () => {
    const user = userEvent.setup();
    server.use(
      fail("post", "/api/v1/admin/products", {
        status: 422,
        slug: "validation-failed",
        title: "Invalid product",
        detail: "SKU LT-2 belongs to another variant.",
        errors: [
          { field: "slug", code: "taken", message: "That handle is taken." },
          { field: "variants.0.price", code: "range", message: "Too cheap." },
          { field: "variants.0", code: "row", message: "Row problem." },
          { field: "variants.9.sku", code: "x", message: "No such row." },
          { field: "sku", code: "taken", message: "SKU in use." },
          { field: "attributes", code: "x", message: "Unmapped." },
        ],
      }),
    );
    renderWithMe(<ProductEditor productId={null} />);
    await user.type(screen.getByLabelText("Title"), "Tee");
    await user.type(screen.getByLabelText("URL handle"), "tee");
    await user.click(screen.getByRole("button", { name: "Add a variant" }));
    await user.type(screen.getByRole("textbox", { name: "SKU, Default" }), "LT-1");
    await user.type(screen.getByRole("textbox", { name: "Price, Default" }), "1");
    await user.click(screen.getByRole("button", { name: "Add a variant" }));
    const skus = screen.getAllByRole("textbox", { name: "SKU, Default" });
    await user.type(skus[1] as HTMLElement, "LT-2");
    await user.click(screen.getByRole("button", { name: "Create product" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "SKU LT-2 belongs to another variant.",
    );
    expect(screen.getByLabelText("URL handle")).toHaveAccessibleDescription(
      /That handle is taken\./,
    );
    expect(
      screen.getAllByRole("textbox", { name: "Price, Default" })[0],
    ).toHaveAccessibleDescription("Too cheap.");
    expect(screen.getByText("Row problem.")).toBeInTheDocument();
    expect(screen.getAllByRole("textbox", { name: "SKU, Default" })[1]).toHaveAccessibleDescription(
      "SKU in use.",
    );
    expect(screen.queryByText("No such row.")).not.toBeInTheDocument();
    expect(screen.queryByText("Unmapped.")).not.toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();

    // Editing a field clears the server's error on it.
    await user.type(screen.getByLabelText("URL handle"), "-2");
    expect(screen.queryByText("That handle is taken.")).not.toBeInTheDocument();
    // Any variant edit clears the variants' server errors.
    await user.type(
      screen.getAllByRole("textbox", { name: "Price, Default" })[0] as HTMLElement,
      "0",
    );
    expect(screen.queryByText("Too cheap.")).not.toBeInTheDocument();
  });

  it("discards a new draft back to empty", async () => {
    const user = userEvent.setup();
    renderWithMe(<ProductEditor productId={null} />);
    await user.type(screen.getByLabelText("Title"), "Draft");
    await user.click(screen.getByRole("button", { name: "Add an option" }));
    await user.click(screen.getByRole("button", { name: "Add a variant" }));
    await user.click(screen.getByRole("button", { name: "Create product" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByLabelText("Title")).toHaveValue("");
    expect(screen.queryByLabelText("Option 1 name")).not.toBeInTheDocument();
    expect(screen.getByText("No variants yet")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("generates variants from options, with SKUs from the handle", async () => {
    const user = userEvent.setup();
    renderWithMe(<ProductEditor productId={null} />);
    await user.type(screen.getByLabelText("Title"), "Linen Tee");
    await user.click(screen.getByRole("button", { name: "Add an option" }));
    await user.type(screen.getByLabelText("Option 1 name"), "Size");
    await user.type(screen.getByLabelText("Values"), "S, M");
    await user.click(screen.getByRole("button", { name: "Generate variants (2)" }));
    await toasted("success", "2 variants added");
    expect(screen.getByRole("textbox", { name: "SKU, S" })).toHaveValue("LINEN-TEE-S");
    expect(screen.getByRole("textbox", { name: "SKU, M" })).toHaveValue("LINEN-TEE-M");

    await user.click(screen.getByRole("button", { name: "Generate variants (2)" }));
    await toasted("info", "Every combination already has a variant.");

    await user.clear(screen.getByLabelText("Values"));
    await user.type(screen.getByLabelText("Values"), "S, M, L");
    await user.click(screen.getByRole("button", { name: "Generate variants (3)" }));
    await toasted("success", "1 variant added");
  });

  it("switches between the editor's sections on small screens", async () => {
    const user = userEvent.setup();
    renderWithMe(<ProductEditor productId={null} />);
    const content = screen.getByRole("tab", { name: "Content" });
    const publishing = screen.getByRole("tab", { name: "Publishing & SEO" });
    expect(content).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Content" })).not.toHaveClass("hidden");
    expect(screen.getByRole("tabpanel", { name: "Publishing & SEO" })).toHaveClass("hidden");
    await user.click(publishing);
    expect(publishing).toHaveAttribute("aria-selected", "true");
    expect(content).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tabpanel", { name: "Content" })).toHaveClass("hidden");
  });
});

// ── Existing product ──────────────────────────────────────────────────────

describe("ProductEditor — loading", () => {
  it("shows a skeleton, then the product", async () => {
    serveProduct(productView({ subtitle: "Sub", brand: "Velo", category: "tops" }));
    renderWithMe(<ProductEditor productId={PRODUCT_ID} />);
    expect(screen.getByRole("status", { name: "Loading product" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 1, name: "Linen tee" })).toBeInTheDocument();
    expect(screen.getByText(/^Updated /)).toBeInTheDocument();
    expect(screen.getByLabelText("Subtitle (optional)")).toHaveValue("Sub");
    expect(screen.getByLabelText("URL handle")).toHaveAccessibleDescription(
      "Lowercase letters, digits and hyphens.",
    );
    expect(screen.getByRole("link", { name: "Inventory" })).toHaveAttribute("href", "/inventory");
    // Nothing changed yet: no save bar, and the action is a plain Publish.
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish" })).toBeInTheDocument();
    expect(await screen.findByLabelText("Category (optional)")).toHaveValue("tops");
  });

  it("says when the product does not exist", async () => {
    server.use(fail("get", PRODUCT_PATH, { status: 404, slug: "not-found", title: "Not found" }));
    renderWithMe(<ProductEditor productId={PRODUCT_ID} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This product does not exist, or was deleted.",
    );
    expect(screen.getByRole("link", { name: "Back to products" })).toHaveAttribute(
      "href",
      "/products",
    );
  });

  it("offers a retry when loading fails", async () => {
    const user = userEvent.setup();
    server.use(
      fail("get", PRODUCT_PATH, { status: 500, title: "Server error", detail: "Database down." }),
    );
    renderWithMe(<ProductEditor productId={PRODUCT_ID} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We could not load this product. Database down.",
    );
    serveProduct(productView());
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Linen tee" })).toBeInTheDocument();
  });
});

describe("ProductEditor — saving an existing product", () => {
  it("saves only the changed fields", async () => {
    const user = userEvent.setup();
    let sent: unknown;
    server.use(
      on("patch", PRODUCT_PATH, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(
          productView({ title: "Linen tee II", brand: "Velo", collections: ["summer"] }),
        );
      }),
    );
    await renderExisting(productView({ seo_title: "Old", collections: ["summer"] }));
    await user.type(screen.getByLabelText("Title"), " II");
    expect(saveBar()).toHaveTextContent("Unsaved changes");
    expect(screen.getByRole("button", { name: "Save and publish" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Brand (optional)"), "Velo");
    await user.clear(screen.getByLabelText("Description"));
    await user.clear(screen.getByLabelText("Page title (optional)"));
    await user.type(screen.getByLabelText("Meta description (optional)"), "Meta");
    await user.type(screen.getByLabelText("Subtitle (optional)"), "Sub");
    await user.selectOptions(await screen.findByLabelText("Category (optional)"), "clothing");
    await user.click(screen.getByRole("checkbox", { name: "Archive (hidden)" }));
    await user.click(screen.getByRole("radio", { name: /Archived/ }));
    await user.clear(screen.getByLabelText("URL handle"));
    await user.type(screen.getByLabelText("URL handle"), "linen-tee-2");

    await user.click(screen.getByRole("button", { name: "Save" }));
    await toasted("success", "Product saved");
    expect(router.refresh).toHaveBeenCalled();
    expect(sent).toEqual({
      title: "Linen tee II",
      slug: "linen-tee-2",
      subtitle: "Sub",
      description: null,
      brand: "Velo",
      status: "archived",
      category: "clothing",
      collections: ["archive", "summer"],
      seo_title: null,
      seo_description: "Meta",
    });
    // The server's version is now the saved state.
    expect(screen.getByRole("heading", { level: 1, name: "Linen tee II" })).toBeInTheDocument();
  });

  it("publishes, and unpublishes, with a single click", async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    server.use(
      on("patch", PRODUCT_PATH, async ({ request }) => {
        const body = (await request.json()) as { status: string };
        bodies.push(body);
        return HttpResponse.json(
          productView({
            status: body.status,
            published_at: "2026-02-01T00:00:00Z",
          }),
        );
      }),
    );
    await renderExisting();
    await user.click(screen.getByRole("button", { name: "Publish" }));
    await toasted("success", "Saved and published");
    expect(bodies).toEqual([{ status: "active" }]);
    expect(screen.getByRole("link", { name: "View in store" })).toHaveAttribute(
      "href",
      "http://localhost:3000/products/linen-tee",
    );
    // Published: the handle is locked.
    expect(screen.getByLabelText("URL handle")).toBeDisabled();
    expect(screen.getByLabelText("URL handle")).toHaveAccessibleDescription(
      "Locked after the first publish, so links and search results keep working.",
    );

    await user.type(screen.getByLabelText("Title"), "!");
    expect(screen.getByRole("button", { name: "Save and unpublish" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByLabelText("Title")).toHaveValue("Linen tee");
    await user.click(screen.getByRole("button", { name: "Unpublish" }));
    await toasted("success", "Saved and unpublished");
    expect(bodies[1]).toEqual({ status: "draft" });
  });

  it("saves variant edits, deletions and additions before the product", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    const product = productView({
      options: [{ name: "Size", values: [{ value: "S" }, { value: "M" }] }],
      variants: [
        variantView(),
        variantView({ id: VARIANT_ID_2, sku: "TEE-M", title: "M", option_values: { Size: "M" } }),
      ],
    });
    const saved = productView({
      options: [{ name: "Size", values: [{ value: "S" }, { value: "L" }] }],
      variants: [
        variantView({ sku: "TEE-S2" }),
        variantView({ id: "v-new", sku: "TEE-L", title: "L", option_values: { Size: "L" } }),
      ],
    });
    server.use(
      on("patch", "/api/v1/admin/variants/{variant_id}", async ({ request, params }) => {
        calls.push(`PATCH ${String(params["variant_id"])} ${JSON.stringify(await request.json())}`);
        return HttpResponse.json(product);
      }),
      on("delete", "/api/v1/admin/variants/{variant_id}", ({ params }) => {
        calls.push(`DELETE ${String(params["variant_id"])}`);
        return HttpResponse.json(product);
      }),
      on("post", "/api/v1/admin/products/{product_id}/variants", async ({ request }) => {
        const body = (await request.json()) as { sku: string; options: unknown; price: number };
        calls.push(`POST ${body.sku} ${JSON.stringify(body.options)} ${String(body.price)}`);
        return HttpResponse.json(saved, { status: 201 });
      }),
    );
    await renderExisting(product);
    const sku = screen.getByRole("textbox", { name: "SKU, S" });
    await user.clear(sku);
    await user.type(sku, "TEE-S2");
    await user.click(screen.getByRole("button", { name: "Remove variant M" }));
    await user.clear(screen.getByLabelText("Values"));
    await user.type(screen.getByLabelText("Values"), "S, M, L");
    await user.click(screen.getAllByRole("button", { name: "Add a variant" })[0] as HTMLElement);
    await user.selectOptions(screen.getByRole("combobox", { name: "Size, variant Default" }), "L");
    await user.type(screen.getByRole("textbox", { name: "SKU, L" }), "TEE-L");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await toasted("success", "Product saved");
    expect(calls).toEqual([
      `PATCH ${VARIANT_ID} {"sku":"TEE-S2"}`,
      `DELETE ${VARIANT_ID_2}`,
      'POST TEE-L {"Size":"L"} 2500',
    ]);
    expect(screen.getByRole("textbox", { name: "SKU, L" })).toHaveValue("TEE-L");
    expect(screen.queryByText("New")).not.toBeInTheDocument();
  });

  it("keeps failed variant changes as typed and explains what was not saved", async () => {
    const user = userEvent.setup();
    const product = productView({
      options: [{ name: "Size", values: [{ value: "S" }, { value: "M" }] }],
      variants: [
        variantView(),
        variantView({ id: VARIANT_ID_2, sku: "TEE-M", title: "M", option_values: { Size: "M" } }),
      ],
    });
    server.use(
      fail("patch", "/api/v1/admin/variants/{variant_id}", {
        status: 409,
        title: "Conflict",
        detail: "SKU TEE-X is taken.",
        errors: [{ field: "sku", code: "taken", message: "Taken by another product." }],
      }),
      fail("delete", "/api/v1/admin/variants/{variant_id}", {
        status: 409,
        title: "Conflict",
        detail: "This variant has orders.",
      }),
      fail("post", "/api/v1/admin/products/{product_id}/variants", {
        status: 422,
        title: "Invalid",
        errors: [{ field: "weird", code: "x", message: "Ignored." }],
      }),
    );
    await renderExisting(product);
    await user.type(screen.getByRole("textbox", { name: "SKU, S" }), "-X");
    await user.click(screen.getByRole("button", { name: "Remove variant M" }));
    await user.clear(screen.getByLabelText("Values"));
    await user.type(screen.getByLabelText("Values"), "S, M, L");
    await user.click(screen.getAllByRole("button", { name: "Add a variant" })[0] as HTMLElement);
    await user.selectOptions(screen.getByRole("combobox", { name: "Size, variant Default" }), "L");
    await user.type(screen.getByRole("textbox", { name: "SKU, L" }), "TEE-L");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "3 variant changes could not be saved.",
    );
    await toasted("error", "Some changes were not saved");
    expect(screen.getByRole("textbox", { name: "SKU, S" })).toHaveValue("TEE-S-X");
    expect(screen.getByRole("textbox", { name: "SKU, S" })).toHaveAccessibleDescription(
      "Taken by another product.",
    );
    expect(screen.getByText("This variant has orders.")).toBeInTheDocument();
    expect(screen.getByText("Deleted when you save")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "SKU, L" })).toHaveValue("TEE-L");
    expect(screen.getByText("Invalid")).toBeInTheDocument();
  });

  it("reports a failed product update alongside failed variant changes", async () => {
    const user = userEvent.setup();
    server.use(
      fail("patch", "/api/v1/admin/variants/{variant_id}", {
        status: 409,
        title: "Conflict",
        detail: "Variant changed.",
      }),
      fail("patch", PRODUCT_PATH, {
        status: 422,
        title: "Invalid",
        detail: "Check the title.",
        errors: [{ field: "title", code: "x", message: "Not that title." }],
      }),
    );
    await renderExisting();
    await user.type(screen.getByRole("textbox", { name: "SKU, S" }), "2");
    await user.type(screen.getByLabelText("Title"), "!");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The product details were not saved: Check the title. 1 variant changes also failed.",
    );
    expect(screen.getByLabelText("Title")).toHaveValue("Linen tee!");
    expect(screen.getByLabelText("Title")).toHaveAccessibleDescription("Not that title.");
  });

  it("reports a failed product update on its own, and a single failed variant", async () => {
    const user = userEvent.setup();
    server.use(fail("patch", PRODUCT_PATH, { status: 500, title: "Server error" }));
    await renderExisting();
    await user.type(screen.getByLabelText("Title"), "!");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The product details were not saved: Server error",
    );

    server.use(
      ok("patch", PRODUCT_PATH, productView({ title: "Linen tee!" })),
      fail("patch", "/api/v1/admin/variants/{variant_id}", { status: 500, title: "Nope" }),
    );
    await user.type(screen.getByRole("textbox", { name: "SKU, S" }), "2");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("1 variant change could not be saved.");
    });
    // The product saved, so its fields now show the server's version.
    expect(screen.getByLabelText("Title")).toHaveValue("Linen tee!");
  });

  it("is read-only without catalog:write", async () => {
    await renderExisting(
      productView({ media: [] }),
      staff({ role: "support", permissions: ["admin:access"] }),
    );
    expect(screen.getByRole("tabpanel", { name: "Content" })).toBeDisabled();
    expect(screen.getByRole("tabpanel", { name: "Publishing & SEO" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Publish/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.getByText("No images.")).toBeInTheDocument();
  });

  it("falls back to draft for an unknown status, and to USD without variants", async () => {
    await renderExisting(productView({ status: "legacy", variants: [], options: [] }));
    expect(screen.getByRole("radio", { name: /Draft/ })).toBeChecked();
    expect(screen.getByText("legacy")).toBeInTheDocument();
    expect(screen.getByText("No variants yet")).toBeInTheDocument();
  });
});

describe("ProductEditor — organisation", () => {
  it("offers a retry when categories or collections fail to load", async () => {
    const user = userEvent.setup();
    server.use(fail("get", "/api/v1/admin/collections", { status: 500, title: "Down" }));
    renderWithMe(<ProductEditor productId={null} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Categories or collections did not load.",
    );
    expect(screen.getByLabelText("Category (optional)")).toBeInTheDocument();
    server.use(ok("get", "/api/v1/admin/collections", []));
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No collections yet.")).toBeInTheDocument();
    // Retrying sits inside the product form, but must not submit (and validate) it.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create product" })).toBeInTheDocument();
  });

  it("keeps the category placeholder when categories fail", async () => {
    server.use(fail("get", "/api/v1/admin/categories", { status: 500, title: "Down" }));
    renderWithMe(<ProductEditor productId={null} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Categories or collections did not load.",
    );
    expect(screen.queryByRole("combobox", { name: /Category/ })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Summer" })).toBeInTheDocument();
  });
});

describe("ProductEditor — unsaved changes", () => {
  it("asks before following an in-app link or closing the tab", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await renderExisting(productView({ status: "active" }));
    const inventory = screen.getByRole("link", { name: "Inventory" });

    // Clean: leaving needs no confirmation.
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    await user.type(screen.getByLabelText("Title"), "!");
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);

    await user.click(inventory);
    expect(confirm).toHaveBeenCalledWith("You have unsaved changes. Leave without saving them?");
    expect(router.push).not.toHaveBeenCalled();

    // New-tab links, modified clicks, same-page and off-site links are not guarded.
    // (A bubbling listener stops jsdom from attempting the navigation itself.)
    confirm.mockClear();
    const noNavigation = (event: MouseEvent) => {
      event.preventDefault();
    };
    document.addEventListener("click", noNavigation);
    const here = document.createElement("a");
    here.href = window.location.href;
    const away = document.createElement("a");
    away.href = "https://elsewhere.test/page";
    document.body.append(here, away);
    await user.click(screen.getByRole("link", { name: "View in store" }));
    fireEvent.click(inventory, { ctrlKey: true });
    fireEvent.click(inventory, { button: 1 });
    fireEvent.click(here);
    fireEvent.click(away);
    fireEvent.click(document.body);
    expect(confirm).not.toHaveBeenCalled();
    document.removeEventListener("click", noNavigation);
    here.remove();
    away.remove();
  });
});
