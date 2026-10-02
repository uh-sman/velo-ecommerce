import type { Schema } from "@velo/api-client";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { ORDER_ID, orderRow, page, usd } from "@/test/fixtures/orders";
import { router, setNavigation } from "@/test/navigation";
import { renderWithMe, staff } from "@/test/render";
import { fail, ok, on, server } from "@/test/server";

import { OrderList } from "./order-list";

type Row = Schema<"AdminOrderSummaryView">;

const ORDERS = "/api/v1/admin/orders" as const;

const ROWS: Row[] = [
  orderRow({ needs_attention: true }),
  orderRow({
    id: "o2",
    number: "VELO-1002",
    customer_name: null,
    email: "grace@example.com",
    item_count: 1,
    total: usd(1999),
    payment_status: "pending",
    fulfilment_status: "fulfilled",
    status: "pending",
  }),
];

/** Serves orders and records each query string. */
function serveOrders(
  rows: Row[] = ROWS,
  pagination: Partial<Schema<"PaginationInfo">> = {},
): URLSearchParams[] {
  const queries: URLSearchParams[] = [];
  server.use(
    on("get", ORDERS, ({ request }) => {
      queries.push(new URL(request.url).searchParams);
      return HttpResponse.json(page(rows, pagination));
    }),
  );
  return queries;
}

function renderList(search = "") {
  setNavigation({ pathname: "/orders", search });
  const view = renderWithMe(<OrderList />);
  return { ...view, user: userEvent.setup() };
}

beforeEach(() => {
  server.use(ok("get", "/api/v1/admin/saved-views", []));
});

describe("OrderList", () => {
  it("tells staff without the orders permission to ask for it", () => {
    renderWithMe(<OrderList />, { me: staff({ permissions: ["admin:access"] }) });
    expect(screen.getByText("You do not have access to orders")).toBeInTheDocument();
  });

  it("opens on the fulfilment queue and lists orders with their states", async () => {
    const queries = serveOrders();
    renderList();
    expect(screen.getByLabelText("Loading orders")).toBeInTheDocument();
    const table = await screen.findByRole("table", { name: "Orders" });

    expect(Object.fromEntries(queries[0] ?? [])).toEqual({
      limit: "50",
      payment_status: "paid",
      fulfilment_status: "unfulfilled",
    });
    expect(screen.getByText("2 orders · Needs fulfilment")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Needs fulfilment" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Unpaid" })).not.toHaveAttribute("aria-current");

    const [first, second] = within(table).getAllByRole("row").slice(1);
    expect(
      within(first as HTMLElement).getByRole("img", { name: "Needs attention" }),
    ).toBeVisible();
    expect(within(first as HTMLElement).getByRole("link", { name: "VELO-1001" })).toHaveAttribute(
      "href",
      `/orders/${ORDER_ID}`,
    );
    expect(first).toHaveTextContent("Ada Lovelace");
    expect(first).toHaveTextContent("ada@example.com");
    expect(first).toHaveTextContent("$50.00");
    expect(first).toHaveTextContent("4 items");
    expect(first).toHaveTextContent("Paid");
    expect(first).toHaveTextContent("Unfulfilled");
    expect(first).toHaveTextContent("Confirmed");

    expect(within(second as HTMLElement).queryByRole("img")).not.toBeInTheDocument();
    expect(second).toHaveTextContent("grace@example.com");
    expect(second).toHaveTextContent("1 item");
    expect(second).toHaveTextContent("Unpaid");
    expect(second).toHaveTextContent("Shipped");
    expect(screen.getByText("Showing 2 of 2")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("reads every filter from the URL and sends it to the API", async () => {
    const queries = serveOrders([orderRow()]);
    renderList(
      "status=processing&payment_status=paid&fulfilment_status=unfulfilled&q=ada&placed_from=2026-09-01&placed_to=2026-09-30&min_total=1000&max_total=5000",
    );
    await screen.findByRole("table", { name: "Orders" });
    const sent = queries[0];
    expect(sent?.get("status")).toBe("processing");
    expect(sent?.get("q")).toBe("ada");
    expect(sent?.get("min_total")).toBe("1000");
    expect(sent?.get("max_total")).toBe("5000");
    expect(sent?.get("placed_from")).toBe(new Date("2026-09-01T00:00:00").toISOString());
    expect(screen.getByText("1 order match these filters")).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveValue("ada");
    expect(screen.getByLabelText("Status")).toHaveValue("processing");
    expect(screen.getByLabelText("Placed from")).toHaveValue("2026-09-01");
    expect(screen.getByLabelText("Placed from")).toHaveAttribute("max", "2026-09-30");
    expect(screen.getByLabelText("Placed to")).toHaveAttribute("min", "2026-09-01");
    expect(screen.getByLabelText("Min total")).toHaveValue("10.00");
    expect(screen.getByLabelText("Max total")).toHaveValue("50.00");
    expect(screen.getByRole("link", { name: "Clear filters" })).toHaveAttribute(
      "href",
      "/orders?all=1",
    );
  });

  it("shows all orders, with no clear button, for all=1", async () => {
    const queries = serveOrders([], { total_count: 0 });
    renderList("all=1");
    expect(await screen.findByText("No orders yet")).toBeInTheDocument();
    expect(screen.getByText(/Orders appear here the moment/)).toBeInTheDocument();
    expect(Object.fromEntries(queries[0] ?? [])).toEqual({ limit: "50" });
    expect(screen.getByText("0 orders · All orders")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Clear filters" })).not.toBeInTheDocument();
  });

  it("offers to show all orders when filters match nothing", async () => {
    serveOrders([], { total_count: null });
    renderList("q=nothing");
    expect(await screen.findByText("No orders match these filters")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Show all orders" })).toHaveAttribute(
      "href",
      "/orders?all=1",
    );
    expect(screen.getByText("Find, ship and refund orders.")).toBeInTheDocument();
  });

  it("recovers from a failed load", async () => {
    server.use(fail("get", ORDERS, { status: 500 }));
    const { user } = renderList();
    expect(await screen.findByRole("alert")).toHaveTextContent("We could not load orders.");
    serveOrders();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table", { name: "Orders" })).toBeInTheDocument();
  });

  it("loads more with the cursor, and retries a failed page", async () => {
    const queries: URLSearchParams[] = [];
    let failMore = true;
    server.use(
      on("get", ORDERS, ({ request }) => {
        const params = new URL(request.url).searchParams;
        queries.push(params);
        if (!params.get("cursor")) {
          return HttpResponse.json(
            page([orderRow()], { has_more: true, next_cursor: "c2", total_count: 2 }),
          );
        }
        if (failMore) {
          failMore = false;
          return HttpResponse.json({ type: "x", title: "Oops", status: 500 }, { status: 500 });
        }
        return HttpResponse.json(page([ROWS[1] as Row], { total_count: null }));
      }),
    );
    const { user } = renderList("all=1");
    await screen.findByText("Showing 1 of 2");
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load more orders.");
    expect(screen.getAllByRole("row")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Showing 2 of 2");
    expect(queries.at(-1)?.get("cursor")).toBe("c2");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "VELO-1002" })).toBeInTheDocument();
  });

  it("pushes a filter change to the URL, keeping the others", async () => {
    serveOrders();
    const { user } = renderList();
    await screen.findByRole("table", { name: "Orders" });
    await user.selectOptions(screen.getByLabelText("Status"), "processing");
    expect(router.push).toHaveBeenLastCalledWith(
      "/orders?status=processing&payment_status=paid&fulfilment_status=unfulfilled",
      { scroll: false },
    );
    await user.selectOptions(screen.getByLabelText("Payment"), "");
    expect(router.push).toHaveBeenLastCalledWith("/orders?fulfilment_status=unfulfilled", {
      scroll: false,
    });
    await user.selectOptions(screen.getByLabelText("Fulfilment"), "");
    expect(router.push).toHaveBeenLastCalledWith("/orders?payment_status=paid", { scroll: false });
  });

  it("sets and clears the date range", async () => {
    serveOrders();
    renderList("placed_to=2026-09-30");
    await screen.findByRole("table", { name: "Orders" });
    fireEvent.change(screen.getByLabelText("Placed from"), { target: { value: "2026-09-01" } });
    expect(router.push).toHaveBeenLastCalledWith(
      "/orders?placed_from=2026-09-01&placed_to=2026-09-30",
      { scroll: false },
    );
    fireEvent.change(screen.getByLabelText("Placed to"), { target: { value: "" } });
    expect(router.push).toHaveBeenLastCalledWith("/orders?all=1", { scroll: false });
  });

  it("searches after a pause without adding history, or at once on Enter", async () => {
    serveOrders();
    const { user } = renderList("all=1");
    await screen.findByRole("table", { name: "Orders" });
    const search = screen.getByRole("searchbox", { name: "Search" });
    await user.type(search, "ada ");
    expect(router.replace).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith("/orders?q=ada", { scroll: false });
    });
    expect(router.replace).toHaveBeenCalledTimes(1);

    await user.type(search, "x{Enter}");
    expect(router.push).toHaveBeenLastCalledWith("/orders?q=ada+x", { scroll: false });
    // The pending debounce was cancelled by the submit.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(router.replace).toHaveBeenCalledTimes(1);
  });

  it("commits money filters in minor units on blur or Enter, and only when they change", async () => {
    serveOrders();
    const { user } = renderList("min_total=1000");
    await screen.findByRole("table", { name: "Orders" });

    const min = screen.getByLabelText("Min total");
    await user.click(min);
    await user.tab(); // unchanged: no navigation
    expect(router.push).not.toHaveBeenCalled();

    await user.clear(min);
    await user.type(min, "12.50");
    await user.tab();
    expect(router.push).toHaveBeenLastCalledWith("/orders?min_total=1250", { scroll: false });

    const max = screen.getByLabelText("Max total");
    await user.type(max, "$99{Enter}");
    expect(router.push).toHaveBeenLastCalledWith("/orders?min_total=1000&max_total=9900", {
      scroll: false,
    });

    await user.clear(min);
    await user.type(min, "{Enter}");
    expect(router.push).toHaveBeenLastCalledWith("/orders?all=1", { scroll: false });
  });

  it("follows the URL when it changes, and ignores an answer a newer filter overtook", async () => {
    let releaseFirst: () => void = () => undefined;
    server.use(
      on("get", ORDERS, async ({ request }) => {
        const q = new URL(request.url).searchParams.get("q");
        if (q === "slow") {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
          return HttpResponse.json(page([orderRow({ number: "SLOW-1" })]));
        }
        return HttpResponse.json(page([orderRow({ number: "FAST-1" })]));
      }),
    );
    const { rerender } = renderList("q=slow");
    await waitFor(() => {
      expect(screen.getByRole("searchbox", { name: "Search" })).toHaveValue("slow");
    });
    setNavigation({ pathname: "/orders", search: "q=fast" });
    rerender(<OrderList />);
    expect(await screen.findByRole("link", { name: "FAST-1" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveValue("fast");
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("link", { name: "SLOW-1" })).not.toBeInTheDocument();
  });

  it("applies a saved view through the URL", async () => {
    serveOrders();
    server.use(
      ok("get", "/api/v1/admin/saved-views", [
        { id: "v1", name: "Big", scope: "orders", query: { min_total: "10000" } },
      ]),
    );
    const { user } = renderList();
    await screen.findByRole("table", { name: "Orders" });
    await user.click(screen.getByRole("button", { name: "Saved views" }));
    await user.click(await screen.findByRole("button", { name: "Big" }));
    expect(router.push).toHaveBeenCalledWith("/orders?min_total=10000", { scroll: false });
  });
});
