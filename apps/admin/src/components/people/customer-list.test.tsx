import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { cursorPage, customerView } from "@/test/fixtures/people";
import { fail, ok, on, server } from "@/test/server";

import { CustomerList } from "./customer-list";

const PATH = "/api/v1/admin/customers";

describe("CustomerList", () => {
  it("lists customers newest first, linking each to its profile", async () => {
    const urls: URL[] = [];
    server.use(
      on("get", PATH, ({ request }) => {
        urls.push(new URL(request.url));
        return HttpResponse.json(
          cursorPage(
            [
              customerView(),
              customerView({
                id: "c2",
                first_name: null,
                last_name: null,
                email: "nameless@example.com",
                role: "staff",
                lifetime_value: null,
                last_order_at: null,
                order_count: 0,
              }),
            ],
            { total: 2 },
          ),
        );
      }),
    );
    render(<CustomerList />);
    expect(screen.getByLabelText("Loading customers")).toHaveAttribute("aria-busy", "true");

    const table = await screen.findByRole("table", { name: "Customers" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(table).getByRole("link", { name: "Ada Lovelace" })).toHaveAttribute(
      "href",
      "/customers/c0000000-0000-4000-8000-000000000001",
    );
    const ada = rows[1];
    const nameless = rows[2];
    if (!ada || !nameless) throw new Error("rows missing");
    expect(within(ada).getByText("$123.45")).toBeInTheDocument();
    expect(within(ada).getByText("3")).toBeInTheDocument();
    expect(within(ada).queryByText("Staff")).not.toBeInTheDocument();
    expect(within(nameless).getByRole("link", { name: "No name" })).toHaveAttribute(
      "href",
      "/customers/c2",
    );
    expect(within(nameless).getByText("Staff")).toBeInTheDocument();
    expect(within(nameless).getAllByText("—").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Showing 2 of 2 customers")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();

    expect(urls).toHaveLength(1);
    expect(urls[0]?.searchParams.get("limit")).toBe("50");
    expect(urls[0]?.searchParams.has("q")).toBe(false);
  });

  it("says when there are no customers yet", async () => {
    server.use(ok("get", PATH, cursorPage([])));
    render(<CustomerList />);
    expect(await screen.findByText("No customers yet")).toBeInTheDocument();
    expect(
      screen.getByText("Customers appear here when they create an account or place an order."),
    ).toBeInTheDocument();
  });

  it("searches after typing settles, and says when nothing matches", async () => {
    const queries: (string | null)[] = [];
    server.use(
      on("get", PATH, ({ request }) => {
        const q = new URL(request.url).searchParams.get("q");
        queries.push(q);
        return HttpResponse.json(cursorPage(q ? [] : [customerView()]));
      }),
    );
    const user = userEvent.setup();
    render(<CustomerList />);
    await screen.findByRole("table", { name: "Customers" });

    await user.type(
      screen.getByRole("searchbox", { name: "Search customers by email or name" }),
      "  zed ",
    );
    expect(await screen.findByText("No customers match “zed”")).toBeInTheDocument();
    expect(screen.getByText("Try part of an email address or a surname.")).toBeInTheDocument();
    // One request on mount, one once typing settled — not one per keystroke.
    expect(queries).toEqual([null, "zed"]);
  });

  it("shows the API's problem and retries", async () => {
    server.use(
      fail("get", PATH, { status: 503, title: "Unavailable", detail: "The store is restarting." }),
    );
    const user = userEvent.setup();
    render(<CustomerList />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The store is restarting.");

    server.use(ok("get", PATH, cursorPage([customerView()])));
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: "Ada Lovelace" })).toBeInTheDocument();
  });

  it("loads the next page with the cursor, and retries a failed page", async () => {
    let pageTwoFails = true;
    server.use(
      on("get", PATH, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("cursor");
        if (!cursor) {
          return HttpResponse.json(cursorPage([customerView()], { next: "page-2", total: 2 }));
        }
        if (pageTwoFails) {
          pageTwoFails = false;
          return HttpResponse.json(
            { type: "https://velo.dev/errors/x", title: "Page failed", status: 500 },
            { status: 500 },
          );
        }
        return HttpResponse.json(
          cursorPage([customerView({ id: "c2", first_name: "Grace", last_name: "Hopper" })]),
        );
      }),
    );
    const user = userEvent.setup();
    render(<CustomerList />);
    await screen.findByText("Showing 1 of 2 customers");

    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Page failed")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("link", { name: "Grace Hopper" })).toBeInTheDocument();
    expect(screen.getByText("Showing 2 of 2 customers")).toBeInTheDocument();
    expect(screen.queryByText("Page failed")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Load more|Try again/ })).not.toBeInTheDocument();
  });
});
