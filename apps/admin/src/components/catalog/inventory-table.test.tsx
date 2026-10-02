import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Schema } from "@velo/api-client";
import { HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InventoryTable } from "@/components/catalog/inventory-table";
import {
  deferred,
  movement,
  pagination,
  spyOnToasts,
  stockRow,
  stockView,
} from "@/test/fixtures/catalog-lists";
import { renderWithMe, staff } from "@/test/render";
import { fail, on, server } from "@/test/server";

type StockRow = Schema<"StockRowView">;

const INVENTORY = "/api/v1/admin/inventory";
const ADJUST = "/api/v1/admin/inventory/{variant_id}/adjust";
const VARIANT = "/api/v1/admin/inventory/{variant_id}";
const MOVEMENTS = "/api/v1/admin/inventory/{variant_id}/movements";

const RUNNER = stockRow();
const CAP = stockRow({
  variant_id: "var-2",
  product_id: "prod-2",
  product_title: "Cap",
  variant_title: "One size",
  sku: "CAP-1",
  low_stock: true,
  stock: stockView({ quantity_on_hand: 3, quantity_reserved: 0, available: 3, reorder_point: 5 }),
});

/** Serves one page of stock rows and records each query string. */
function serveStock(rows: StockRow[], page: Partial<Schema<"PaginationInfo">> = {}) {
  const queries: URLSearchParams[] = [];
  server.use(
    on("get", INVENTORY, ({ request }) => {
      queries.push(new URL(request.url).searchParams);
      return HttpResponse.json({ data: rows, pagination: pagination(page) });
    }),
  );
  return queries;
}

function stockTable() {
  return screen.getByRole("table", { name: "Stock levels" });
}

/** The cells of a variant's row: product, SKU, on hand, reserved, available, reorder, status. */
function cellsFor(sku: string): HTMLElement[] {
  const row = within(stockTable()).getByText(sku).closest("tr");
  if (!row) throw new Error(`no row for ${sku}`);
  return within(row).getAllByRole("cell");
}

function cellText(sku: string, index: number): string | null | undefined {
  return cellsFor(sku)[index]?.textContent;
}

async function openAdjust(sku = "TR-42") {
  const user = userEvent.setup();
  await waitFor(() => cellsFor(sku));
  const row = within(stockTable()).getByText(sku).closest("tr") as HTMLElement;
  await user.click(within(row).getByRole("button", { name: "Adjust" }));
  return user;
}

function adjustForm(sku = "TR-42") {
  return screen.getByRole("form", { name: `Adjust ${sku}` });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("InventoryTable", () => {
  it("loads stock for every variant", async () => {
    const queries = serveStock(
      [
        RUNNER,
        CAP,
        stockRow({
          variant_id: "var-3",
          sku: "OUT-1",
          stock: stockView({ available: 0, quantity_on_hand: 0, quantity_reserved: 0 }),
        }),
        stockRow({
          variant_id: "var-4",
          sku: "BACK-1",
          stock: stockView({ available: -2, allow_backorder: true }),
        }),
        stockRow({
          variant_id: "var-5",
          sku: "GIFT-1",
          stock: stockView({ track_inventory: false, available: 0 }),
        }),
      ],
      { total_count: 5 },
    );
    renderWithMe(<InventoryTable />);
    expect(screen.getByRole("status", { name: "Loading stock levels" })).toBeInTheDocument();

    await waitFor(() => cellsFor("TR-42"));
    expect(queries[0]?.get("limit")).toBe("50");
    expect(queries[0]?.get("low_stock")).toBe("false");
    expect(queries[0]?.has("q")).toBe(false);
    expect(queries[0]?.has("cursor")).toBe(false);

    expect(within(stockTable()).getAllByRole("link", { name: "Trail Runner" })[0]).toHaveAttribute(
      "href",
      "/products/prod-1",
    );
    expect(
      cellsFor("TR-42")
        .slice(0, 7)
        .map((cell) => cell.textContent),
    ).toEqual(["Trail RunnerSize 42", "TR-42", "12", "2", "10", "5", "In stock"]);
    expect(cellText("CAP-1", 6)).toBe("Low stock");
    expect(cellText("OUT-1", 6)).toBe("Out of stock");
    expect(cellText("BACK-1", 6)).toBe("Backorder");
    expect(cellText("GIFT-1", 6)).toBe("Not tracked");
    expect(screen.getByText("1–5 of 5 variants")).toBeInTheDocument();
  });

  it("starts from the filters it is given", async () => {
    const queries = serveStock([CAP]);
    renderWithMe(<InventoryTable initialQuery="cap" initialLowStock />);
    await waitFor(() => cellsFor("CAP-1"));
    expect(queries[0]?.get("q")).toBe("cap");
    expect(queries[0]?.get("low_stock")).toBe("true");
    expect(screen.getByLabelText("Search")).toHaveValue("cap");
    expect(screen.getByRole("checkbox", { name: "Low stock only" })).toBeChecked();
  });

  it("sends the search and low-stock filter and can clear them", async () => {
    const queries = serveStock([]);
    const user = userEvent.setup();
    renderWithMe(<InventoryTable />);
    expect(
      await screen.findByText("No variants yet — stock appears with products"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear the filters" })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Search"), " TR ");
    await waitFor(() => {
      expect(queries.at(-1)?.get("q")).toBe("TR");
    });
    await user.click(screen.getByRole("checkbox", { name: "Low stock only" }));
    await waitFor(() => {
      expect(queries.at(-1)?.get("low_stock")).toBe("true");
    });
    expect(await screen.findByText("Nothing matches")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear the filters" }));
    expect(screen.getByLabelText("Search")).toHaveValue("");
    expect(screen.getByRole("checkbox", { name: "Low stock only" })).not.toBeChecked();
    await waitFor(() => {
      expect(queries.at(-1)?.has("q")).toBe(false);
    });
    expect(queries.at(-1)?.get("low_stock")).toBe("false");
  });

  it("shows the API's problem and retries on request", async () => {
    let calls = 0;
    server.use(
      on("get", INVENTORY, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json(
              {
                type: "https://velo.dev/errors/forbidden",
                title: "Forbidden",
                status: 403,
                detail: "Inventory is off limits.",
              },
              { status: 403 },
            )
          : HttpResponse.json({ data: [RUNNER], pagination: pagination() });
      }),
    );
    const user = userEvent.setup();
    renderWithMe(<InventoryTable />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We could not load stock levels. Inventory is off limits.",
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => cellsFor("TR-42"));
  });

  it("hides adjustments from staff without inventory:write", async () => {
    serveStock([RUNNER]);
    renderWithMe(<InventoryTable />, {
      me: staff({ role: "support", permissions: ["admin:access", "orders:read"] }),
    });
    await waitFor(() => cellsFor("TR-42"));
    expect(screen.queryByRole("button", { name: "Adjust" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stock history for TR-42" })).toBeInTheDocument();
  });

  it("restocks optimistically and settles on the API's numbers", async () => {
    const toasts = spyOnToasts();
    serveStock([RUNNER]);
    const gate = deferred();
    let sent: unknown;
    let target = "";
    server.use(
      on("post", ADJUST, async ({ request, params }) => {
        sent = await request.json();
        target = String(params["variant_id"]);
        await gate.promise;
        return HttpResponse.json({
          movement: movement({ quantity_delta: 5 }),
          stock: stockView({ quantity_on_hand: 18, available: 15, quantity_reserved: 3 }),
        });
      }),
    );
    renderWithMe(<InventoryTable />);
    const user = await openAdjust();
    const toggle = screen.getByRole("button", { name: "Adjust" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-controls", "adjust-var-1");

    const form = adjustForm();
    expect(within(form).getByLabelText("Reason")).toHaveValue("restock");
    expect(within(form).queryByRole("group", { name: "Direction" })).not.toBeInTheDocument();
    expect(within(form).getByText("On hand: 12")).toBeInTheDocument();
    await user.type(within(form).getByLabelText("Quantity to add"), "5");
    expect(within(form).getByText("On hand: 12 → 17")).toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Save adjustment" }));

    // Optimistic: on hand and available move before the API answers.
    expect(cellText("TR-42", 2)).toBe("17");
    expect(cellText("TR-42", 4)).toBe("15");
    gate.resolve();
    await waitFor(() => {
      expect(toasts.success).toHaveBeenCalledWith("TR-42: +5 (restock)");
    });
    expect(sent).toEqual({ delta: 5, reason: "restock", note: null });
    expect(target).toBe("var-1");
    expect(cellText("TR-42", 2)).toBe("18");
    expect(cellText("TR-42", 3)).toBe("3");
    expect(cellText("TR-42", 4)).toBe("15");
    expect(screen.queryByRole("form", { name: "Adjust TR-42" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Adjust" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("writes off damage as a negative movement with its note", async () => {
    const toasts = spyOnToasts();
    serveStock([RUNNER]);
    let sent: unknown;
    server.use(
      on("post", ADJUST, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({
          movement: movement({ quantity_delta: -3, reason: "damage" }),
          // Low stock once available drops to the reorder point.
          stock: stockView({ quantity_on_hand: 9, available: 5 }),
        });
      }),
    );
    renderWithMe(<InventoryTable />);
    const user = await openAdjust();
    const form = adjustForm();
    await user.selectOptions(within(form).getByLabelText("Reason"), "damage");
    await user.type(within(form).getByLabelText("Quantity to remove"), "3");
    expect(within(form).getByText("On hand: 12 → 9")).toBeInTheDocument();
    await user.type(within(form).getByRole("textbox", { name: /^Note/ }), "  Water damage  ");
    await user.click(within(form).getByRole("button", { name: "Save adjustment" }));
    await waitFor(() => {
      expect(toasts.success).toHaveBeenCalledWith("TR-42: -3 (damage)");
    });
    expect(sent).toEqual({ delta: -3, reason: "damage", note: "Water damage" });
    expect(cellText("TR-42", 6)).toBe("Low stock");
  });

  it("asks which way a count correction goes", async () => {
    spyOnToasts();
    serveStock([RUNNER]);
    const sent: unknown[] = [];
    server.use(
      on("post", ADJUST, async ({ request }) => {
        sent.push(await request.json());
        return HttpResponse.json({ movement: movement(), stock: stockView() });
      }),
    );
    renderWithMe(<InventoryTable />);
    const user = await openAdjust();
    const form = adjustForm();
    await user.selectOptions(within(form).getByLabelText("Reason"), "adjustment");
    const direction = within(form).getByRole("group", { name: "Direction" });
    expect(within(direction).getByRole("radio", { name: "Add" })).toBeChecked();
    await user.click(within(direction).getByRole("radio", { name: "Remove" }));
    await user.type(within(form).getByLabelText("Quantity to remove"), "2");
    expect(within(form).getByText("On hand: 12 → 10")).toBeInTheDocument();
    await user.click(within(direction).getByRole("radio", { name: "Add" }));
    expect(within(form).getByLabelText("Quantity to add")).toHaveValue("2");
    await user.click(within(direction).getByRole("radio", { name: "Remove" }));
    await user.click(within(form).getByRole("button", { name: "Save adjustment" }));
    await waitFor(() => {
      expect(sent).toEqual([{ delta: -2, reason: "adjustment", note: null }]);
    });
  });

  it("refuses a quantity that is not a whole number above zero", async () => {
    serveStock([RUNNER]);
    let calls = 0;
    server.use(
      on("post", ADJUST, () => {
        calls += 1;
        return HttpResponse.json({ movement: movement(), stock: stockView() });
      }),
    );
    renderWithMe(<InventoryTable />);
    const user = await openAdjust();
    const form = adjustForm();
    const quantity = within(form).getByLabelText("Quantity to add");
    const save = within(form).getByRole("button", { name: "Save adjustment" });

    await user.click(save);
    expect(within(form).getByText("Enter a whole number greater than zero.")).toBeInTheDocument();
    expect(quantity).toHaveAttribute("aria-invalid", "true");

    for (const value of ["0", "2.5", "-4", "ten"]) {
      await user.clear(quantity);
      await user.type(quantity, value);
      await user.click(save);
      expect(within(form).getByText("Enter a whole number greater than zero.")).toBeInTheDocument();
    }
    expect(within(form).getByText("On hand: 12")).toBeInTheDocument();
    expect(calls).toBe(0);
    expect(cellText("TR-42", 2)).toBe("12");
  });

  it("rolls the optimistic change back and shows the API's errors", async () => {
    serveStock([RUNNER]);
    server.use(
      fail("post", ADJUST, {
        status: 422,
        slug: "validation",
        title: "Invalid adjustment",
        detail: "Not enough stock to remove.",
        errors: [
          { field: "delta", code: "insufficient", message: "Only 12 on hand." },
          { field: "reason", code: "invalid", message: "Pick another reason." },
          { field: "note", code: "too_long", message: "Too long." },
        ],
      }),
    );
    renderWithMe(<InventoryTable />);
    const user = await openAdjust();
    const form = adjustForm();
    await user.selectOptions(within(form).getByLabelText("Reason"), "theft");
    await user.type(within(form).getByLabelText("Quantity to remove"), "20");
    await user.click(within(form).getByRole("button", { name: "Save adjustment" }));

    expect(await within(form).findByRole("alert")).toHaveTextContent("Not enough stock to remove.");
    expect(within(form).getByText("Only 12 on hand.")).toBeInTheDocument();
    expect(within(form).getByText("Pick another reason.")).toBeInTheDocument();
    expect(within(form).getByText("Too long.")).toBeInTheDocument();
    expect(within(form).getByLabelText("Reason")).toHaveAttribute("aria-invalid", "true");
    expect(cellText("TR-42", 2)).toBe("12");
    expect(cellText("TR-42", 4)).toBe("10");
    // The panel stays open for a fix.
    expect(within(form).getByRole("button", { name: "Save adjustment" })).toBeEnabled();
  });

  it("closes the panel with Cancel or a second click on Adjust", async () => {
    serveStock([RUNNER]);
    renderWithMe(<InventoryTable />);
    const user = await openAdjust();
    await user.click(within(adjustForm()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "Adjust TR-42" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Adjust" }));
    expect(adjustForm()).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Adjust" }));
    expect(screen.queryByRole("form", { name: "Adjust TR-42" })).not.toBeInTheDocument();
  });

  it("saves a new reorder point", async () => {
    const toasts = spyOnToasts();
    serveStock([RUNNER]);
    let sent: unknown;
    server.use(
      on("patch", VARIANT, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(stockView({ reorder_point: 10 }));
      }),
    );
    renderWithMe(<InventoryTable />);
    const user = await openAdjust();
    const field = screen.getByLabelText("Reorder point");
    const save = screen.getByRole("button", { name: "Save reorder point" });
    expect(field).toHaveValue("5");
    expect(save).toBeDisabled();

    await user.clear(field);
    await user.type(field, "10");
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => {
      expect(toasts.success).toHaveBeenCalledWith("TR-42: reorder point 10");
    });
    expect(sent).toEqual({ reorder_point: 10 });
    expect(cellText("TR-42", 5)).toBe("10");
    expect(cellText("TR-42", 6)).toBe("Low stock");
  });

  it("refuses a reorder point that is not a whole number", async () => {
    serveStock([RUNNER]);
    renderWithMe(<InventoryTable />);
    const user = await openAdjust();
    const field = screen.getByLabelText("Reorder point");
    await user.clear(field);
    await user.type(field, "-1");
    await user.click(screen.getByRole("button", { name: "Save reorder point" }));
    expect(screen.getByText("A whole number, zero or more.")).toBeInTheDocument();
    expect(field).toHaveAttribute("aria-invalid", "true");
  });

  it("shows the API's reason when a reorder point is refused", async () => {
    serveStock([RUNNER]);
    server.use(
      fail("patch", VARIANT, { status: 409, slug: "conflict", title: "Variant was deleted" }),
    );
    renderWithMe(<InventoryTable />);
    const user = await openAdjust();
    const field = screen.getByLabelText("Reorder point");
    await user.clear(field);
    await user.type(field, "0");
    await user.click(screen.getByRole("button", { name: "Save reorder point" }));
    expect(await screen.findByText("Variant was deleted")).toBeInTheDocument();
    expect(cellText("TR-42", 5)).toBe("5");
  });

  it("pages with the API's cursor", async () => {
    const queries: URLSearchParams[] = [];
    server.use(
      on("get", INVENTORY, ({ request }) => {
        const params = new URL(request.url).searchParams;
        queries.push(params);
        const second = params.get("cursor") === "c-2";
        return HttpResponse.json({
          data: [second ? CAP : RUNNER],
          pagination: pagination({ has_more: !second, next_cursor: second ? null : "c-2" }),
        });
      }),
    );
    const user = userEvent.setup();
    renderWithMe(<InventoryTable />);
    await waitFor(() => cellsFor("TR-42"));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => cellsFor("CAP-1"));
    expect(queries.at(-1)?.get("cursor")).toBe("c-2");
    await user.click(screen.getByRole("button", { name: "Previous" }));
    await waitFor(() => cellsFor("TR-42"));
  });
});

describe("InventoryTable stock history", () => {
  it("lists a variant's movements and loads older ones on request", async () => {
    serveStock([RUNNER]);
    const queries: URLSearchParams[] = [];
    let variant = "";
    server.use(
      on("get", MOVEMENTS, ({ request, params }) => {
        variant = String(params["variant_id"]);
        const query = new URL(request.url).searchParams;
        queries.push(query);
        const older = query.get("cursor") === "older";
        return HttpResponse.json({
          data: older
            ? [movement({ id: "m-3", reason: "cycle_count", quantity_delta: -1 })]
            : [
                movement({
                  id: "m-1",
                  reason: "restock",
                  quantity_delta: 5,
                  note: "PO-1042",
                  actor_id: "staff-1",
                }),
                movement({
                  id: "m-2",
                  reason: "sale",
                  quantity_delta: -2,
                  reference_type: "order",
                }),
              ],
          pagination: pagination({ next_cursor: older ? null : "older", has_more: !older }),
        });
      }),
    );
    const user = userEvent.setup();
    renderWithMe(<InventoryTable />);
    await waitFor(() => cellsFor("TR-42"));
    await user.click(screen.getByRole("button", { name: "Stock history for TR-42" }));

    const sheet = await screen.findByRole("dialog", { name: "Stock history" });
    expect(sheet).toHaveAccessibleDescription("Trail Runner — Size 42 (TR-42)");
    const list = await within(sheet).findByRole("list");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Restock");
    expect(items[0]).toHaveTextContent("· by staff");
    expect(items[0]).toHaveTextContent("PO-1042");
    expect(items[0]).toHaveTextContent("+5");
    expect(items[1]).toHaveTextContent("Sale");
    expect(items[1]).toHaveTextContent("· order");
    expect(items[1]).not.toHaveTextContent("by staff");
    expect(items[1]).toHaveTextContent("-2");
    expect(variant).toBe("var-1");
    expect(queries[0]?.get("limit")).toBe("50");
    expect(queries[0]?.has("cursor")).toBe(false);

    await user.click(within(sheet).getByRole("button", { name: "Load older movements" }));
    await waitFor(() => {
      expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    });
    expect(queries.at(-1)?.get("cursor")).toBe("older");
    expect(within(list).getAllByRole("listitem")[2]).toHaveTextContent("Cycle count");
    expect(
      within(sheet).queryByRole("button", { name: "Load older movements" }),
    ).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("says when a variant has no movements", async () => {
    serveStock([RUNNER]);
    server.use(
      on("get", MOVEMENTS, () => HttpResponse.json({ data: [], pagination: pagination() })),
    );
    const user = userEvent.setup();
    renderWithMe(<InventoryTable />);
    await waitFor(() => cellsFor("TR-42"));
    await user.click(screen.getByRole("button", { name: "Stock history for TR-42" }));
    const sheet = await screen.findByRole("dialog", { name: "Stock history" });
    expect(await within(sheet).findByText("No movements yet")).toBeInTheDocument();
  });

  it("recovers from a failed first load", async () => {
    serveStock([RUNNER]);
    const gate = deferred();
    let calls = 0;
    server.use(
      on("get", MOVEMENTS, async () => {
        calls += 1;
        if (calls === 1) {
          await gate.promise;
          return HttpResponse.json(
            { type: "https://velo.dev/errors/http-500", title: "Oops", status: 500 },
            { status: 500 },
          );
        }
        return HttpResponse.json({ data: [movement()], pagination: pagination() });
      }),
    );
    const user = userEvent.setup();
    renderWithMe(<InventoryTable />);
    await waitFor(() => cellsFor("TR-42"));
    await user.click(screen.getByRole("button", { name: "Stock history for TR-42" }));
    const sheet = await screen.findByRole("dialog", { name: "Stock history" });
    expect(within(sheet).getByRole("status", { name: "Loading history" })).toBeInTheDocument();
    gate.resolve();
    expect(await within(sheet).findByRole("alert")).toHaveTextContent(
      "We could not load the history.",
    );
    await user.click(within(sheet).getByRole("button", { name: "Try again" }));
    expect(await within(sheet).findByText("Restock")).toBeInTheDocument();
    expect(within(sheet).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("retries loading older movements from where it stopped", async () => {
    serveStock([RUNNER]);
    const cursors: (string | null)[] = [];
    server.use(
      on("get", MOVEMENTS, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("cursor");
        cursors.push(cursor);
        if (cursor === null) {
          return HttpResponse.json({
            data: [movement({ id: "m-1" })],
            pagination: pagination({ has_more: true, next_cursor: "older" }),
          });
        }
        if (cursors.length === 2) {
          return HttpResponse.json(
            { type: "https://velo.dev/errors/http-503", title: "Busy", status: 503 },
            { status: 503 },
          );
        }
        return HttpResponse.json({
          data: [movement({ id: "m-2", reason: "return", quantity_delta: 1 })],
          pagination: pagination(),
        });
      }),
    );
    const user = userEvent.setup();
    renderWithMe(<InventoryTable />);
    await waitFor(() => cellsFor("TR-42"));
    await user.click(screen.getByRole("button", { name: "Stock history for TR-42" }));
    const sheet = await screen.findByRole("dialog", { name: "Stock history" });
    await user.click(await within(sheet).findByRole("button", { name: "Load older movements" }));
    expect(await within(sheet).findByRole("alert")).toBeInTheDocument();
    // What was already loaded stays on screen.
    expect(within(sheet).getAllByRole("listitem")).toHaveLength(1);

    await user.click(within(sheet).getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(within(sheet).getAllByRole("listitem")).toHaveLength(2);
    });
    expect(cursors).toEqual([null, "older", "older"]);
    expect(within(sheet).getByText("Return")).toBeInTheDocument();
  });
});
