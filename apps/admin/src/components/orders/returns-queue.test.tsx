import type { Schema } from "@velo/api-client";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ORDER_ID,
  TOTE_ID,
  adminOrder,
  orderLine,
  orderRow,
  page,
  returnView,
  toast,
  toteLine,
  usd,
} from "@/test/fixtures/orders";
import { router, setNavigation } from "@/test/navigation";
import { renderWithMe, staff } from "@/test/render";
import { fail, ok, on, server } from "@/test/server";

import { ReturnsQueue } from "./returns-queue";

vi.mock("sonner", async () => (await import("@/test/fixtures/orders")).sonnerMock);

type Return = Schema<"ReturnView">;

const RETURNS = "/api/v1/admin/returns" as const;
const RETURN = "/api/v1/admin/returns/{return_id}" as const;

/** Serves one page of returns and records each query string. */
function serveReturns(rows: Return[], pagination: Partial<Schema<"PaginationInfo">> = {}) {
  const queries: URLSearchParams[] = [];
  server.use(
    on("get", RETURNS, ({ request }) => {
      queries.push(new URL(request.url).searchParams);
      return HttpResponse.json(page(rows, pagination));
    }),
  );
  return queries;
}

/** The order lookup a return needs: search by number, then load by id. */
function serveOrderLookup(order = adminOrder()) {
  const searches: (string | null)[] = [];
  server.use(
    on("get", "/api/v1/admin/orders", ({ request }) => {
      searches.push(new URL(request.url).searchParams.get("q"));
      return HttpResponse.json(page([orderRow({ id: "other", number: "VELO-10010" }), orderRow()]));
    }),
    ok("get", "/api/v1/admin/orders/{order_id}", order),
  );
  return searches;
}

/** Records each PATCH and answers with the return in `status`. */
function servePatch(status: string, extra: Partial<Return> = {}) {
  const sent: unknown[] = [];
  server.use(
    on("patch", RETURN, async ({ request }) => {
      sent.push(await request.json());
      return HttpResponse.json(returnView({ status, ...extra }));
    }),
  );
  return sent;
}

function renderQueue(search = "", me = staff()) {
  setNavigation({ pathname: "/returns", search });
  renderWithMe(<ReturnsQueue />, { me });
  return userEvent.setup();
}

function card(rma = "RMA-0001") {
  return screen.getByText(rma).closest("li") as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ReturnsQueue", () => {
  it("tells staff without the orders permission to ask for it", () => {
    renderQueue("", staff({ permissions: ["admin:access"] }));
    expect(screen.getByText("You do not have access to returns")).toBeInTheDocument();
  });

  it("lists returns with their order, reason, units and notes", async () => {
    const queries = serveReturns([
      returnView({
        customer_note: "Too small",
        staff_note: "Checked",
        refund_amount: usd(1500),
        status: "refunded",
        lines: [
          {
            order_item_id: TOTE_ID,
            product_title: "Canvas tote",
            variant_title: "",
            sku: "TOTE",
            quantity: 2,
            condition: "opened",
            restock: true,
          },
        ],
      }),
      returnView({ id: "r2", rma_number: "RMA-0002", order_number: null, reason: "odd_reason" }),
    ]);
    renderQueue();
    expect(screen.getByLabelText("Loading orders")).toBeInTheDocument();
    await screen.findByText("RMA-0001");
    expect(Object.fromEntries(queries[0] ?? [])).toEqual({ limit: "50" });

    const first = card();
    expect(within(first).getByRole("link", { name: "VELO-1001" })).toHaveAttribute(
      "href",
      "/orders?q=VELO-1001",
    );
    expect(first).toHaveTextContent("Wrong size or fit");
    expect(first).toHaveTextContent("2 units · refunded $15.00");
    expect(first).toHaveTextContent("Customer: Too small");
    expect(first).toHaveTextContent("Staff note: Checked");
    expect(within(first).getByText("Refunded")).toBeInTheDocument();

    const second = card("RMA-0002");
    expect(within(second).queryByRole("link")).not.toBeInTheDocument();
    expect(second).toHaveTextContent("Order · odd reason");
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
  });

  it("filters by status through the URL", async () => {
    const queries = serveReturns([]);
    const user = renderQueue("status=approved");
    expect(await screen.findByText("No returns with this status")).toBeInTheDocument();
    expect(queries[0]?.get("status")).toBe("approved");
    expect(screen.getByRole("button", { name: "Approved" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Received" }));
    expect(router.push).toHaveBeenCalledWith("/returns?status=received", { scroll: false });
    await user.click(screen.getByRole("button", { name: "All" }));
    expect(router.push).toHaveBeenLastCalledWith("/returns", { scroll: false });
  });

  it("ignores a status it does not know", async () => {
    const queries = serveReturns([]);
    renderQueue("status=bogus");
    expect(await screen.findByText("No returns yet")).toBeInTheDocument();
    expect(queries[0]?.has("status")).toBe(false);
  });

  it("recovers from a failed load", async () => {
    server.use(fail("get", RETURNS, { status: 500 }));
    const user = renderQueue();
    expect(await screen.findByRole("alert")).toHaveTextContent("We could not load returns.");
    serveReturns([returnView()]);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("RMA-0001")).toBeInTheDocument();
  });

  it("loads more, and says when the next page fails", async () => {
    let calls = 0;
    server.use(
      on("get", RETURNS, ({ request }) => {
        calls += 1;
        const cursor = new URL(request.url).searchParams.get("cursor");
        if (!cursor) {
          return HttpResponse.json(page([returnView()], { has_more: true, next_cursor: "c2" }));
        }
        return calls === 2
          ? HttpResponse.json({ type: "x", title: "Oops", status: 500 }, { status: 500 })
          : HttpResponse.json(page([returnView({ id: "r2", rma_number: "RMA-0002" })]));
      }),
    );
    const user = renderQueue();
    await screen.findByText("RMA-0001");
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Could not load more returns.", expect.anything());
    });
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("RMA-0002")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("offers only the moves a role may make", async () => {
    serveReturns([
      returnView(),
      returnView({ id: "r2", rma_number: "RMA-0002", status: "received" }),
      returnView({ id: "r3", rma_number: "RMA-0003", status: "closed" }),
    ]);
    renderQueue("", staff({ permissions: ["admin:access", "orders:read", "orders:refund"] }));
    await screen.findByText("RMA-0001");
    expect(within(card()).queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(within(card("RMA-0002")).getByRole("button", { name: "Refund…" })).toBeInTheDocument();
    expect(
      within(card("RMA-0002")).queryByRole("button", { name: "Close" }),
    ).not.toBeInTheDocument();
    expect(
      within(card("RMA-0003"))
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Show items"]);
  });

  it("approves in one click and shows the new state", async () => {
    serveReturns([returnView()]);
    const sent = servePatch("approved");
    const user = renderQueue();
    await screen.findByText("RMA-0001");
    await user.click(within(card()).getByRole("button", { name: "Approve" }));
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("RMA-0001: approved", expect.anything());
    });
    expect(sent).toEqual([{ action: "approve", include_shipping: false }]);
    expect(within(card()).getByText("Approved")).toBeInTheDocument();
    expect(within(card()).getByRole("button", { name: "Mark in transit" })).toBeInTheDocument();
  });

  it("reports a refused quick action", async () => {
    serveReturns([returnView({ status: "approved" })]);
    server.use(
      fail("patch", RETURN, { status: 409, title: "Conflict", detail: "Already in transit." }),
    );
    const user = renderQueue();
    await screen.findByText("RMA-0001");
    await user.click(within(card()).getByRole("button", { name: "Mark in transit" }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("RMA-0001: Already in transit.", expect.anything());
    });
  });

  it("marks in transit", async () => {
    serveReturns([returnView({ status: "approved" })]);
    const sent = servePatch("in_transit");
    const user = renderQueue();
    await screen.findByText("RMA-0001");
    await user.click(within(card()).getByRole("button", { name: "Mark in transit" }));
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("RMA-0001: marked in transit", expect.anything());
    });
    expect(sent).toEqual([{ action: "mark_in_transit", include_shipping: false }]);
  });

  it("rejects with a reason", async () => {
    serveReturns([returnView()]);
    const sent = servePatch("rejected");
    const user = renderQueue();
    await screen.findByText("RMA-0001");
    await user.click(within(card()).getByRole("button", { name: "Reject…" }));
    const dialog = screen.getByRole("dialog", { name: "Reject return RMA-0001?" });
    await user.type(within(dialog).getByLabelText("Reason"), "Worn");
    await user.click(within(dialog).getByRole("button", { name: "Reject return" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(sent).toEqual([{ action: "reject", include_shipping: false, staff_note: "Worn" }]);
    expect(toast.success).toHaveBeenCalledWith("RMA-0001: rejected", expect.anything());
  });

  it("shows the items once the order is found, and links to it", async () => {
    serveReturns([returnView({ status: "rejected" })]);
    const searches = serveOrderLookup();
    const user = renderQueue();
    await screen.findByText("RMA-0001");
    await user.click(within(card()).getByRole("button", { name: "Show items" }));
    const items = within(card()).getByRole("button", { name: "Hide items" });
    expect(items).toHaveAttribute("aria-expanded", "true");
    expect(await within(card()).findByText("1 × Canvas tote")).toBeInTheDocument();
    expect(searches).toEqual(["VELO-1001"]);
    expect(within(card()).getByRole("link", { name: "VELO-1001" })).toHaveAttribute(
      "href",
      `/orders/${ORDER_ID}`,
    );
    await user.click(items);
    expect(within(card()).queryByText("1 × Canvas tote")).not.toBeInTheDocument();
    // Opening again uses the order it already found.
    await user.click(within(card()).getByRole("button", { name: "Show items" }));
    expect(within(card()).getByText("1 × Canvas tote")).toBeInTheDocument();
    expect(searches).toHaveLength(1);
  });

  it("says when a return's order cannot be found", async () => {
    serveReturns([
      returnView({
        status: "closed",
        lines: [
          {
            order_item_id: TOTE_ID,
            product_title: "Canvas tote",
            variant_title: "",
            sku: "TOTE",
            quantity: 1,
            condition: "damaged",
            restock: false,
          },
        ],
      }),
    ]);
    server.use(ok("get", "/api/v1/admin/orders", page([])));
    const user = renderQueue();
    await screen.findByText("RMA-0001");
    await user.click(within(card()).getByRole("button", { name: "Show items" }));
    expect(await within(card()).findByText("The order could not be found.")).toBeInTheDocument();
    expect(card()).toHaveTextContent("1 × Item · damaged");
  });

  it("keeps showing a placeholder title when the order lookup fails", async () => {
    serveReturns([returnView({ status: "closed" })]);
    server.use(
      ok("get", "/api/v1/admin/orders", page([orderRow()])),
      fail("get", "/api/v1/admin/orders/{order_id}", { status: 500 }),
    );
    const user = renderQueue();
    await screen.findByText("RMA-0001");
    await user.click(within(card()).getByRole("button", { name: "Show items" }));
    await waitFor(() => {
      expect(within(card()).getByText("1 × Item")).toBeInTheDocument();
    });
    expect(within(card()).getByText("Loading items…")).toBeInTheDocument();
  });

  it("receives a return after inspecting each line", async () => {
    serveReturns([returnView({ status: "in_transit" })]);
    serveOrderLookup(adminOrder({ lines: [orderLine(), toteLine({ variant_title: "Natural" })] }));
    const sent = servePatch("received");
    const user = renderQueue();
    await screen.findByText("RMA-0001");
    await user.click(within(card()).getByRole("button", { name: "Receive…" }));
    const dialog = screen.getByRole("dialog", { name: "Receive return RMA-0001" });
    expect(await within(dialog).findByText("1 × Canvas tote · Natural")).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText("Condition"), "new");
    await user.click(within(dialog).getByRole("checkbox", { name: "Put it back in stock" }));
    await user.type(within(dialog).getByLabelText(/Staff note/), "All good");
    await user.click(within(dialog).getByRole("button", { name: "Mark received" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(sent).toEqual([
      {
        action: "receive",
        include_shipping: false,
        lines: [{ order_item_id: TOTE_ID, condition: "new", restock: true }],
        staff_note: "All good",
      },
    ]);
    expect(toast.success).toHaveBeenCalledWith("RMA-0001: received", expect.anything());
  });

  it("receives without a note", async () => {
    serveReturns([returnView({ status: "approved", order_number: null })]);
    const sent = servePatch("received");
    const user = renderQueue();
    await screen.findByText("RMA-0001");
    await user.click(within(card()).getByRole("button", { name: "Receive…" }));
    const dialog = screen.getByRole("dialog", { name: "Receive return RMA-0001" });
    expect(within(dialog).queryByText("Loading item names…")).not.toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText("Condition"), "damaged");
    await user.click(within(dialog).getByRole("button", { name: "Mark received" }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]).toEqual({
      action: "receive",
      include_shipping: false,
      lines: [{ order_item_id: TOTE_ID, condition: "damaged", restock: false }],
    });
  });

  it("estimates a refund from the order, optionally with shipping", async () => {
    serveReturns([returnView({ status: "received" })]);
    serveOrderLookup();
    const sent = servePatch("refunded", { refund_amount: usd(2000) });
    const user = renderQueue();
    await screen.findByText("RMA-0001");
    await user.click(within(card()).getByRole("button", { name: "Refund…" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Refund about $15.00 to Visa •••• 4242?",
    });
    await user.click(
      within(dialog).getByRole("checkbox", { name: "Also refund the shipping the customer paid" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Refund about $20.00 to Visa •••• 4242?" }),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Refund return" }));
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("RMA-0001: refund issued", expect.anything());
    });
    expect(sent).toEqual([{ action: "refund", include_shipping: true }]);
    expect(card()).toHaveTextContent("refunded $20.00");
  });

  it("warns when the estimate is more than the payment has left", async () => {
    serveReturns([returnView({ status: "received" })]);
    serveOrderLookup(adminOrder({ refundable: usd(500) }));
    const user = renderQueue();
    await screen.findByText("RMA-0001");
    await user.click(within(card()).getByRole("button", { name: "Refund…" }));
    const dialog = await screen.findByRole("dialog", { name: /Refund about \$15\.00/ });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "This looks like more than is left to refund on the payment.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("asks plainly before refunding a return whose order is unknown", async () => {
    serveReturns([returnView({ status: "received", order_number: null })]);
    server.use(fail("patch", RETURN, { status: 409, title: "Nothing to refund" }));
    const user = renderQueue();
    await screen.findByText("RMA-0001");
    await user.click(within(card()).getByRole("button", { name: "Refund…" }));
    const dialog = screen.getByRole("dialog", { name: "Refund return RMA-0001?" });
    await user.click(within(dialog).getByRole("button", { name: "Refund return" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Nothing to refund");
  });

  it("closes a return after confirmation", async () => {
    serveReturns([returnView({ status: "refunded" })]);
    const sent = servePatch("closed");
    const user = renderQueue();
    await screen.findByText("RMA-0001");
    await user.click(within(card()).getByRole("button", { name: "Close" }));
    const dialog = screen.getByRole("dialog", { name: "Close return RMA-0001?" });
    await user.click(within(dialog).getByRole("button", { name: "Close return" }));
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("RMA-0001: closed", expect.anything());
    });
    expect(sent).toEqual([{ action: "close", include_shipping: false }]);
    expect(within(card()).getByText("Closed")).toBeInTheDocument();
  });
});
