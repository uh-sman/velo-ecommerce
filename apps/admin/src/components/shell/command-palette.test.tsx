import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Schema } from "@velo/api-client";
import { HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import { CommandPalette } from "@/components/shell/command-palette";
import { router } from "@/test/navigation";
import { renderWithMe, staff } from "@/test/render";
import { fail, ok, on, server } from "@/test/server";

const PAGINATION = { has_more: false, limit: 5, next_cursor: null };

function order(overrides: Partial<Schema<"AdminOrderSummaryView">> = {}) {
  return {
    id: "00000000-0000-4000-8000-00000000d001",
    number: "VEL-1042",
    email: "ada@example.com",
    customer_name: "Ada Lovelace",
    status: "partially_fulfilled",
    payment_status: "paid",
    fulfilment_status: "partial",
    item_count: 2,
    needs_attention: false,
    placed_at: "2026-09-01T10:00:00Z",
    total: { amount: 4200, currency: "USD" },
    ...overrides,
  } satisfies Schema<"AdminOrderSummaryView">;
}

function customer(overrides: Partial<Schema<"CustomerView">> = {}) {
  return {
    id: "00000000-0000-4000-8000-00000000e001",
    email: "grace@example.com",
    first_name: "Grace",
    last_name: "Hopper",
    created_at: "2026-01-01T00:00:00Z",
    first_order_at: null,
    last_order_at: null,
    lifetime_value: null,
    marketing_opt_in: false,
    order_count: 0,
    role: "customer",
    status: "active",
    ...overrides,
  } satisfies Schema<"CustomerView">;
}

function options() {
  return screen.getAllByRole("option").map((option) => option.textContent);
}

function open(me = staff(), onOpenChange = vi.fn()) {
  renderWithMe(<CommandPalette open onOpenChange={onOpenChange} />, { me });
  return { onOpenChange, input: screen.getByRole("combobox") };
}

describe("CommandPalette", () => {
  it("lists every page the role can open", () => {
    open(staff({ role: "support", permissions: ["admin:access", "orders:read"] }));
    expect(screen.getByRole("dialog", { name: "Search or jump to" })).toBeInTheDocument();
    expect(options().map((text) => text?.replace("Go to page", ""))).toEqual([
      "Dashboard",
      "Orders",
      "Returns",
      "Products",
      "Inventory",
    ]);
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-expanded", "true");
  });

  it("filters pages by label and keyword", async () => {
    server.use(
      ok("get", "/api/v1/admin/orders", { data: [], pagination: PAGINATION }),
      ok("get", "/api/v1/admin/customers", { data: [], pagination: PAGINATION }),
    );
    const { input } = open();
    const user = userEvent.setup();
    await user.type(input, "co");
    expect(options()).toEqual(["DiscountsGo to page", "AnalyticsGo to page"]);
    await user.clear(input);
    await user.type(input, "Coupon");
    expect(options()).toEqual(["DiscountsGo to page"]);
  });

  it("finds orders and customers after a short pause", async () => {
    const queries: string[] = [];
    server.use(
      on("get", "/api/v1/admin/orders", ({ request }) => {
        queries.push(new URL(request.url).search);
        return HttpResponse.json({ data: [order()], pagination: PAGINATION });
      }),
      ok("get", "/api/v1/admin/customers", {
        data: [
          customer(),
          customer({ id: "c2", first_name: null, last_name: null, email: "anon@x.io" }),
        ],
        pagination: PAGINATION,
      }),
    );
    const { input } = open();
    await userEvent.setup().type(input, "ada");

    expect(await screen.findByRole("option", { name: /Order VEL-1042/ })).toHaveTextContent(
      "ada@example.com · partially fulfilled",
    );
    expect(screen.getByRole("option", { name: /Grace Hopper/ })).toHaveTextContent(
      "Customer · grace@example.com",
    );
    expect(
      screen.getByRole("option", { name: /anon@x.io.*Customer · anon@x.io/ }),
    ).toBeInTheDocument();
    expect(queries).toEqual(["?q=ada&limit=5"]);
  });

  it("only searches what the role may read, and drops failed lookups", async () => {
    server.use(fail("get", "/api/v1/admin/orders", { status: 500 }));
    const { input } = open(staff({ permissions: ["admin:access", "orders:read"] }));
    await userEvent.setup().type(input, "zzzz");
    // No customers handler: an unhandled request would fail the test.
    await waitFor(() => {
      expect(screen.getByText("Nothing matches.")).toBeInTheDocument();
    });
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("combobox")).not.toHaveAttribute("aria-activedescendant");
  });

  it("drops a failed customer lookup", async () => {
    server.use(fail("get", "/api/v1/admin/customers", { status: 500 }));
    const { input } = open(staff({ permissions: ["admin:access", "customers:read"] }));
    await userEvent.setup().type(input, "customers");
    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(1);
    });
    expect(screen.getByRole("option", { name: /Customers/ })).toBeInTheDocument();
  });

  it("does not search with fewer than three characters", async () => {
    const { input } = open(staff({ permissions: ["admin:access"] }));
    await userEvent.setup().type(input, "zz");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.getByText("Nothing matches.")).toBeInTheDocument();
  });

  it("moves through results with the arrow keys and opens one with Enter", async () => {
    const { input, onOpenChange } = open(staff({ permissions: ["admin:access", "orders:read"] }));
    const user = userEvent.setup();
    await user.click(input);
    const [first, second] = screen.getAllByRole("option");
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", first?.id);

    await user.keyboard("{ArrowDown}");
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", second?.id);

    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(screen.getAllByRole("option").at(-1)).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowDown}");
    expect(first).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{ArrowDown}{Enter}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(router.push).toHaveBeenCalledWith("/orders");
  });

  it("ignores arrows and Enter when nothing matches", async () => {
    const { input, onOpenChange } = open(staff({ permissions: ["admin:access"] }));
    const user = userEvent.setup();
    await user.type(input, "qq");
    await user.keyboard("{ArrowDown}{ArrowUp}{Enter}");
    expect(router.push).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    await user.keyboard("a");
    expect(input).toHaveValue("qqa");
  });

  it("highlights on hover and opens on click", () => {
    const { onOpenChange } = open(staff({ permissions: ["admin:access"] }));
    const inventory = screen.getByRole("option", { name: /Inventory/ });
    fireEvent.mouseEnter(inventory);
    expect(inventory).toHaveAttribute("aria-selected", "true");
    fireEvent.mouseDown(inventory);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(router.push).toHaveBeenCalledWith("/inventory");
  });

  it("clears the query when closed", async () => {
    const me = staff({ permissions: ["admin:access"] });
    const { rerender } = renderWithMe(<CommandPalette open onOpenChange={vi.fn()} />, { me });
    await userEvent.setup().type(screen.getByRole("combobox"), "inv");
    rerender(<CommandPalette open={false} onOpenChange={vi.fn()} />);
    rerender(<CommandPalette open onOpenChange={vi.fn()} />);
    expect(screen.getByRole("combobox")).toHaveValue("");
  });
});
