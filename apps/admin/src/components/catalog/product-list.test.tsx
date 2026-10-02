import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Schema } from "@velo/api-client";
import { HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProductList } from "@/components/catalog/product-list";
import {
  adminProduct,
  deferred,
  mediaView,
  pagination,
  productRow,
  spyOnToasts,
} from "@/test/fixtures/catalog-lists";
import { renderWithMe, staff } from "@/test/render";
import { on, server } from "@/test/server";

type Row = Schema<"AdminProductRow">;

const PRODUCTS = "/api/v1/admin/products";
const PRODUCT = "/api/v1/admin/products/{product_id}";

const READER = staff({ role: "support", permissions: ["admin:access", "orders:read"] });

const RUNNER = productRow({
  id: "p-1",
  title: "Trail Runner",
  slug: "trail-runner",
  brand: "Velo",
  status: "active",
  image: mediaView({
    url: "https://cdn.velo.test/runner.jpg",
    renditions: [
      { format: "webp", width: 640, height: 640, url: "https://cdn.velo.test/runner-640.webp" },
      { format: "webp", width: 320, height: 320, url: "https://cdn.velo.test/runner-320.webp" },
    ],
  }),
});
const CAP = productRow({
  id: "p-2",
  title: "Cap",
  slug: "cap",
  status: "draft",
  in_stock: false,
  price: null,
  image: mediaView({ url: "https://cdn.velo.test/cap.jpg" }),
});
const SOCKS = productRow({ id: "p-3", title: "Socks", slug: "socks", status: "archived" });

/** Serves one page of products and records each query string. */
function serveProducts(rows: Row[], page: Partial<Schema<"PaginationInfo">> = {}) {
  const queries: URLSearchParams[] = [];
  server.use(
    on("get", PRODUCTS, ({ request }) => {
      queries.push(new URL(request.url).searchParams);
      return HttpResponse.json({ data: rows, pagination: pagination(page) });
    }),
  );
  return queries;
}

interface Patch {
  id: string;
  body: unknown;
}

/** PATCH /products/{id}: refuses the ids in `refuse`, records every request. */
function servePatch(refuse: Record<string, string> = {}) {
  const sent: Patch[] = [];
  server.use(
    on("patch", PRODUCT, async ({ request, params }) => {
      const id = String(params["product_id"]);
      const body: unknown = await request.json();
      sent.push({ id, body });
      const detail = refuse[id];
      if (detail !== undefined) {
        return HttpResponse.json(
          { type: "https://velo.dev/errors/unpublishable", title: "Refused", status: 422, detail },
          { status: 422 },
        );
      }
      return HttpResponse.json(adminProduct({ id }));
    }),
  );
  return sent;
}

function serveDelete(refuse: Record<string, string> = {}) {
  const deleted: string[] = [];
  server.use(
    on("delete", PRODUCT, ({ params }) => {
      const id = String(params["product_id"]);
      const detail = refuse[id];
      if (detail !== undefined) {
        return HttpResponse.json(
          { type: "https://velo.dev/errors/conflict", title: "Conflict", status: 409, detail },
          { status: 409 },
        );
      }
      deleted.push(id);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return deleted;
}

function table() {
  return screen.getByRole("table", { name: "Products" });
}

function rowFor(title: string): HTMLElement {
  const link = within(table()).getByRole("link", { name: title });
  const row = link.closest("tr");
  if (!row) throw new Error(`no row for ${title}`);
  return row;
}

async function openMenu(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(screen.getByRole("button", { name: `Actions for ${title}` }));
  return screen.findByRole("menu");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ProductList", () => {
  it("loads the first page of products", async () => {
    const queries = serveProducts([RUNNER, CAP], { total_count: 2 });
    renderWithMe(<ProductList />);
    expect(screen.getByRole("status", { name: "Loading products" })).toBeInTheDocument();

    const runner = await waitFor(() => rowFor("Trail Runner"));
    expect(queries[0]?.get("limit")).toBe("50");
    expect(queries[0]?.has("q")).toBe(false);
    expect(queries[0]?.has("status")).toBe(false);
    expect(queries[0]?.has("cursor")).toBe(false);

    expect(within(runner).getByRole("link", { name: "Trail Runner" })).toHaveAttribute(
      "href",
      "/products/p-1",
    );
    expect(within(runner).getByText("trail-runner · Velo")).toBeInTheDocument();
    expect(within(runner).getByText("Active")).toBeInTheDocument();
    expect(within(runner).getByText("In stock")).toBeInTheDocument();
    expect(within(runner).getByText("$29.99")).toBeInTheDocument();
    // The smallest rendition that fits the 40px thumbnail.
    expect(within(runner).getByRole("presentation")).toHaveAttribute(
      "src",
      "https://cdn.velo.test/runner-320.webp",
    );

    const cap = rowFor("Cap");
    expect(within(cap).getByText("cap")).toBeInTheDocument();
    expect(within(cap).getByText("Draft")).toBeInTheDocument();
    expect(within(cap).getByText("Out of stock")).toBeInTheDocument();
    expect(within(cap).getByText("—")).toBeInTheDocument();
    expect(within(cap).getByRole("presentation")).toHaveAttribute(
      "src",
      "https://cdn.velo.test/cap.jpg",
    );
    expect(screen.getByText("1–2 of 2 products")).toBeInTheDocument();
  });

  it("shows a placeholder for a product without an image", async () => {
    serveProducts([productRow({ title: "Bare" })]);
    renderWithMe(<ProductList />);
    const row = await waitFor(() => rowFor("Bare"));
    expect(within(row).queryByRole("presentation")).not.toBeInTheDocument();
    expect(within(row).queryByRole("img")).not.toBeInTheDocument();
  });

  it("sends the search and status filter to the API and can clear them", async () => {
    const queries = serveProducts([]);
    const user = userEvent.setup();
    renderWithMe(<ProductList />);
    expect(await screen.findByText("No products yet")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Search"), "  runner ");
    await waitFor(() => {
      expect(queries.at(-1)?.get("q")).toBe("runner");
    });
    await user.selectOptions(screen.getByLabelText("Status"), "Draft");
    await waitFor(() => {
      expect(queries.at(-1)?.get("status")).toBe("draft");
    });
    expect(queries.at(-1)?.get("q")).toBe("runner");
    expect(await screen.findByText("No products match")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear the filters" }));
    expect(screen.getByLabelText("Search")).toHaveValue("");
    expect(screen.getByLabelText("Status")).toHaveValue("");
    await waitFor(() => {
      expect(queries.at(-1)?.has("q")).toBe(false);
    });
    expect(queries.at(-1)?.has("status")).toBe(false);
    expect(await screen.findByText("No products yet")).toBeInTheDocument();
  });

  it("invites a writer to add or import the first product", async () => {
    serveProducts([]);
    renderWithMe(<ProductList />);
    expect(await screen.findByRole("link", { name: "Add your first product" })).toHaveAttribute(
      "href",
      "/products/new",
    );
    expect(screen.getByRole("link", { name: "Import CSV" })).toHaveAttribute(
      "href",
      "/products/import",
    );
  });

  it("gives a read-only role the list without selection or write actions", async () => {
    serveProducts([RUNNER]);
    const user = userEvent.setup();
    renderWithMe(<ProductList />, { me: READER });
    await waitFor(() => rowFor("Trail Runner"));
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();

    const menu = await openMenu(user, "Trail Runner");
    expect(within(menu).getByRole("menuitem", { name: "Edit" })).toHaveAttribute(
      "href",
      "/products/p-1",
    );
    expect(within(menu).getByRole("menuitem", { name: "View in store" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Archive" })).not.toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Delete…" })).not.toBeInTheDocument();
  });

  it("shows no write invitation to a read-only role when the catalog is empty", async () => {
    serveProducts([]);
    renderWithMe(<ProductList />, { me: READER });
    expect(await screen.findByText("No products yet")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Add your first product" })).not.toBeInTheDocument();
  });

  it("shows the API's problem and retries on request", async () => {
    let calls = 0;
    server.use(
      on("get", PRODUCTS, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json(
              { type: "https://velo.dev/errors/unavailable", title: "Unavailable", status: 503 },
              { status: 503 },
            )
          : HttpResponse.json({ data: [RUNNER], pagination: pagination() });
      }),
    );
    const user = userEvent.setup();
    renderWithMe(<ProductList />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We could not load products. Unavailable",
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: "Trail Runner" })).toBeInTheDocument();
  });

  it("selects rows one by one or all at once", async () => {
    serveProducts([RUNNER, CAP]);
    const user = userEvent.setup();
    renderWithMe(<ProductList />);
    await waitFor(() => rowFor("Cap"));
    expect(screen.queryByRole("region", { name: "Bulk actions" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Select Cap" }));
    const bar = screen.getByRole("region", { name: "Bulk actions" });
    expect(within(bar).getByText("1 selected")).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Select all products on this page" }),
    ).not.toBeChecked();

    await user.click(screen.getByRole("checkbox", { name: "Select Trail Runner" }));
    expect(within(bar).getByText("2 selected")).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Select all products on this page" }),
    ).toBeChecked();

    await user.click(screen.getByRole("checkbox", { name: "Select Cap" }));
    expect(within(bar).getByText("1 selected")).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Select all products on this page" }));
    expect(within(bar).getByText("2 selected")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Select all products on this page" }));
    expect(screen.queryByRole("region", { name: "Bulk actions" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Select Cap" }));
    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByRole("region", { name: "Bulk actions" })).not.toBeInTheDocument();
  });

  it("publishes in bulk, reports each failure by name and retries just those", async () => {
    const toasts = spyOnToasts();
    serveProducts([RUNNER, CAP]);
    const refuse: Record<string, string> = { "p-2": "Add a variant before publishing." };
    const sent = servePatch(refuse);
    const user = userEvent.setup();
    renderWithMe(<ProductList />);
    await waitFor(() => rowFor("Cap"));
    await user.click(screen.getByRole("checkbox", { name: "Select all products on this page" }));
    await user.click(screen.getByRole("button", { name: "Publish" }));

    const dialog = await screen.findByRole("dialog", { name: "Publish 2 products?" });
    expect(dialog).toHaveTextContent(
      "Products without a variant cannot be published; they will be listed as failures.",
    );
    expect(
      within(dialog)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Trail Runner", "Cap"]);
    await user.click(within(dialog).getByRole("button", { name: "Publish" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(sent).toHaveLength(2);
    expect(sent).toEqual(
      expect.arrayContaining([
        { id: "p-1", body: { status: "active" } },
        { id: "p-2", body: { status: "active" } },
      ]),
    );
    expect(toasts.warning).toHaveBeenCalledWith("1 published, 1 failed");

    const report = screen.getByRole("alert");
    expect(report).toHaveTextContent("1 published, 1 failed");
    expect(within(report).getByRole("link", { name: "Cap" })).toHaveAttribute(
      "href",
      "/products/p-2",
    );
    expect(report).toHaveTextContent("Cap: Add a variant before publishing.");
    // Only the failure stays selected; the success shows its new status.
    expect(
      within(screen.getByRole("region", { name: "Bulk actions" })).getByText("1 selected"),
    ).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select Cap" })).toBeChecked();
    expect(within(rowFor("Cap")).getByText("Draft")).toBeInTheDocument();

    delete refuse["p-2"];
    await user.click(within(report).getByRole("button", { name: "Retry 1 failed" }));
    await waitFor(() => {
      expect(toasts.success).toHaveBeenCalledWith("1 published");
    });
    expect(sent.at(-1)).toEqual({ id: "p-2", body: { status: "active" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(within(rowFor("Cap")).getByText("Active")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Bulk actions" })).not.toBeInTheDocument();
  });

  it("dismisses the failure report", async () => {
    spyOnToasts();
    serveProducts([CAP]);
    servePatch({ "p-2": "Nope." });
    const user = userEvent.setup();
    renderWithMe(<ProductList />);
    await user.click(await screen.findByRole("checkbox", { name: "Select Cap" }));
    await user.click(screen.getByRole("button", { name: "Archive" }));
    const dialog = await screen.findByRole("dialog", { name: "Archive 1 products?" });
    expect(dialog).toHaveTextContent(
      "Each product is updated on its own; any that fail are listed afterwards.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Archive" }));
    const report = await screen.findByRole("alert");
    expect(report).toHaveTextContent("0 archived, 1 failed");
    await user.click(within(report).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("moves products to draft in bulk", async () => {
    const toasts = spyOnToasts();
    serveProducts([RUNNER]);
    const sent = servePatch();
    const user = userEvent.setup();
    renderWithMe(<ProductList />);
    await user.click(await screen.findByRole("checkbox", { name: "Select Trail Runner" }));
    await user.click(screen.getByRole("button", { name: "Unpublish" }));
    const dialog = await screen.findByRole("dialog", { name: "Unpublish 1 products?" });
    await user.click(within(dialog).getByRole("button", { name: "Unpublish" }));
    await waitFor(() => {
      expect(toasts.success).toHaveBeenCalledWith("1 moved to draft");
    });
    expect(sent).toEqual([{ id: "p-1", body: { status: "draft" } }]);
    expect(within(rowFor("Trail Runner")).getByText("Draft")).toBeInTheDocument();
  });

  it("deletes in bulk and drops the deleted rows", async () => {
    const toasts = spyOnToasts();
    serveProducts([RUNNER, CAP, SOCKS]);
    const deleted = serveDelete();
    const user = userEvent.setup();
    renderWithMe(<ProductList />);
    await user.click(await screen.findByRole("checkbox", { name: "Select Trail Runner" }));
    await user.click(screen.getByRole("checkbox", { name: "Select Socks" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete 2 products?" });
    expect(dialog).toHaveTextContent("Deleted products disappear from the store and this list.");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(toasts.success).toHaveBeenCalledWith("2 deleted");
    });
    expect(deleted.sort()).toEqual(["p-1", "p-3"]);
    expect(within(table()).queryByRole("link", { name: "Trail Runner" })).not.toBeInTheDocument();
    expect(within(table()).queryByRole("link", { name: "Socks" })).not.toBeInTheDocument();
    expect(rowFor("Cap")).toBeInTheDocument();
  });

  it("cancels a bulk action without calling the API", async () => {
    serveProducts([RUNNER]);
    const sent = servePatch();
    const user = userEvent.setup();
    renderWithMe(<ProductList />);
    await user.click(await screen.findByRole("checkbox", { name: "Select Trail Runner" }));
    await user.click(screen.getByRole("button", { name: "Publish" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(sent).toEqual([]);
  });

  it("archives one product from its menu at once, before the API answers", async () => {
    const toasts = spyOnToasts();
    serveProducts([RUNNER]);
    const gate = deferred();
    let sent: unknown;
    server.use(
      on("patch", PRODUCT, async ({ request }) => {
        sent = await request.json();
        await gate.promise;
        return HttpResponse.json(adminProduct({ id: "p-1", status: "archived" }));
      }),
    );
    const user = userEvent.setup();
    renderWithMe(<ProductList />);
    await waitFor(() => rowFor("Trail Runner"));
    const menu = await openMenu(user, "Trail Runner");
    expect(within(menu).getByRole("menuitem", { name: "View in store" })).toHaveAttribute(
      "href",
      "http://localhost:3000/products/trail-runner",
    );
    await user.click(within(menu).getByRole("menuitem", { name: "Archive" }));
    expect(within(rowFor("Trail Runner")).getByText("Archived")).toBeInTheDocument();
    gate.resolve();
    await waitFor(() => {
      expect(toasts.success).toHaveBeenCalledWith("“Trail Runner” archived");
    });
    expect(sent).toEqual({ status: "archived" });
  });

  it("rolls the archive back when the API refuses it", async () => {
    const toasts = spyOnToasts();
    serveProducts([RUNNER]);
    servePatch({ "p-1": "Locked by an import." });
    const user = userEvent.setup();
    renderWithMe(<ProductList />);
    await waitFor(() => rowFor("Trail Runner"));
    const menu = await openMenu(user, "Trail Runner");
    await user.click(within(menu).getByRole("menuitem", { name: "Archive" }));
    await waitFor(() => {
      expect(toasts.error).toHaveBeenCalledWith(
        "Could not archive “Trail Runner”: Locked by an import.",
      );
    });
    expect(within(rowFor("Trail Runner")).getByText("Active")).toBeInTheDocument();
  });

  it("offers neither Archive nor View in store for an archived product", async () => {
    serveProducts([SOCKS]);
    const user = userEvent.setup();
    renderWithMe(<ProductList />);
    await waitFor(() => rowFor("Socks"));
    const menu = await openMenu(user, "Socks");
    expect(within(menu).queryByRole("menuitem", { name: "Archive" })).not.toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "View in store" })).not.toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Delete…" })).toBeInTheDocument();
  });

  it("deletes one product after confirmation", async () => {
    const toasts = spyOnToasts();
    serveProducts([RUNNER, CAP]);
    const deleted = serveDelete();
    const user = userEvent.setup();
    renderWithMe(<ProductList />);
    await waitFor(() => rowFor("Cap"));
    const menu = await openMenu(user, "Cap");
    await user.click(within(menu).getByRole("menuitem", { name: "Delete…" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete “Cap”?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete product" }));
    await waitFor(() => {
      expect(toasts.success).toHaveBeenCalledWith("“Cap” deleted");
    });
    expect(deleted).toEqual(["p-2"]);
    expect(within(table()).queryByRole("link", { name: "Cap" })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("keeps the delete dialog open with the API's reason when it refuses", async () => {
    serveProducts([CAP]);
    serveDelete({ "p-2": "It has open orders." });
    const user = userEvent.setup();
    renderWithMe(<ProductList />);
    await waitFor(() => rowFor("Cap"));
    const menu = await openMenu(user, "Cap");
    await user.click(within(menu).getByRole("menuitem", { name: "Delete…" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete “Cap”?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete product" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("It has open orders.");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(rowFor("Cap")).toBeInTheDocument();
  });

  it("pages with the cursor and drops the selection on a new page", async () => {
    const queries: URLSearchParams[] = [];
    server.use(
      on("get", PRODUCTS, ({ request }) => {
        const params = new URL(request.url).searchParams;
        queries.push(params);
        const second = params.get("cursor") === "next-1";
        return HttpResponse.json({
          data: [second ? CAP : RUNNER],
          pagination: pagination({
            has_more: !second,
            next_cursor: second ? null : "next-1",
          }),
        });
      }),
    );
    const user = userEvent.setup();
    renderWithMe(<ProductList />);
    await user.click(await screen.findByRole("checkbox", { name: "Select Trail Runner" }));
    expect(screen.getByRole("region", { name: "Bulk actions" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => rowFor("Cap"));
    expect(queries.at(-1)?.get("cursor")).toBe("next-1");
    expect(screen.queryByRole("region", { name: "Bulk actions" })).not.toBeInTheDocument();
    expect(screen.getByText("51–51 products")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Previous" }));
    await waitFor(() => rowFor("Trail Runner"));
    expect(queries.at(-1)?.has("cursor")).toBe(false);
  });
});
