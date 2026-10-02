import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { UUID_A, UUID_B, auditEntry, cursorPage } from "@/test/fixtures/people";
import { fail, ok, on, server } from "@/test/server";

import { AuditLog, Changes } from "./audit-log";

const PATH = "/api/v1/admin/audit-log";

/** Answers every request with `respond(query)` and records the query of each. */
function recordQueries(
  respond: (params: URLSearchParams) => Record<string, unknown> = () => cursorPage([]),
) {
  const queries: URLSearchParams[] = [];
  server.use(
    on("get", PATH, ({ request }) => {
      const params = new URL(request.url).searchParams;
      queries.push(params);
      return HttpResponse.json(respond(params));
    }),
  );
  return queries;
}

describe("Changes", () => {
  it("shows a dash when nothing changed", () => {
    const { container, rerender } = render(<Changes changes={null} />);
    expect(container).toHaveTextContent("—");
    rerender(<Changes changes={{}} />);
    expect(container).toHaveTextContent("—");
  });

  it("reads from/to pairs as a change, and anything else as compact values", () => {
    render(
      <Changes
        changes={{
          is_active: { from: true, to: false },
          max_redemptions: { from: null, to: 10 },
          target_ids: ["a", "b"],
          note: "",
          shape: { from: 1, to: 2, extra: 3 },
          title: "Plain",
        }}
      />,
    );
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("is active: true → false");
    expect(items[1]).toHaveTextContent("max redemptions: empty → 10");
    expect(items[2]).toHaveTextContent('target ids: ["a","b"]');
    expect(items[3]).toHaveTextContent("note: empty");
    expect(items[4]).toHaveTextContent('shape: {"from":1,"to":2,"extra":3}');
    expect(items[5]).toHaveTextContent("title: Plain");
    expect(screen.getAllByLabelText("changed to")).toHaveLength(2);
  });
});

describe("AuditLog", () => {
  it("lists entries with who, what and the changes", async () => {
    const queries = recordQueries(() =>
      cursorPage(
        [
          auditEntry(),
          auditEntry({
            id: "a2",
            actor_email: null,
            ip_address: null,
            entity_id: null,
            entity_type: "settings",
            action: "settings.updated",
            changes: null,
          }),
        ],
        { total: 2 },
      ),
    );
    render(<AuditLog />);
    expect(screen.getByLabelText("Loading the audit log")).toBeInTheDocument();

    const table = await screen.findByRole("table", { name: "Audit log" });
    const [, first, second] = within(table).getAllByRole("row");
    if (!first || !second) throw new Error("rows missing");
    expect(within(first).getByText("owner@velo.test")).toBeInTheDocument();
    expect(within(first).getByText("203.0.113.7")).toBeInTheDocument();
    expect(within(first).getByText("discount.updated")).toBeInTheDocument();
    expect(
      within(first).getByRole("button", { name: "3f2a1b4c… — show only this entity" }),
    ).toBeInTheDocument();
    expect(within(first).getByText("title")).toBeInTheDocument();
    expect(within(second).getByText("System")).toBeInTheDocument();
    expect(within(second).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("Showing 2 of 2 entries")).toBeInTheDocument();
    // Unfiltered: nothing to clear.
    expect(screen.queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();

    expect(queries).toHaveLength(1);
    expect(Object.fromEntries(queries[0] ?? [])).toEqual({ limit: "50" });
  });

  it("says when nothing has been recorded yet", async () => {
    server.use(ok("get", PATH, cursorPage([])));
    render(<AuditLog />);
    expect(await screen.findByText("Nothing recorded yet")).toBeInTheDocument();
  });

  it("refuses an entity ID that is not a UUID, without asking the API", async () => {
    const queries = recordQueries();
    const user = userEvent.setup();
    render(<AuditLog />);
    await screen.findByText("Nothing recorded yet");

    const field = screen.getByRole("textbox", { name: "Entity ID" });
    await user.type(field, "order-42");
    await user.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription("An entity ID looks like 3f2a…-…, 36 characters.");
    expect(queries).toHaveLength(1);
  });

  it("sends trimmed filters with whole local days, and clears them", async () => {
    const queries = recordQueries();
    const user = userEvent.setup();
    render(<AuditLog />);
    await screen.findByText("Nothing recorded yet");

    const paste = async (name: string, text: string) => {
      await user.click(screen.getByRole("textbox", { name }));
      await user.paste(text);
    };
    await paste("Who", " owner@velo.test ");
    await paste("Action", " order. ");
    await paste("Entity type", " order ");
    await paste("Entity ID", ` ${UUID_B} `);
    await user.type(screen.getByLabelText("From"), "2026-03-01");
    await user.type(screen.getByLabelText("To"), "2026-03-31");
    await user.click(screen.getByRole("button", { name: "Apply filters" }));

    expect(await screen.findByText("Nothing matches these filters")).toBeInTheDocument();
    expect(Object.fromEntries(queries[1] ?? [])).toEqual({
      actor: "owner@velo.test",
      action: "order.",
      entity_type: "order",
      entity_id: UUID_B,
      since: new Date(2026, 2, 1).toISOString(),
      until: new Date(2026, 3, 1).toISOString(),
      limit: "50",
    });

    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(await screen.findByText("Nothing recorded yet")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Who" })).toHaveValue("");
    expect(Object.fromEntries(queries.at(-1) ?? [])).toEqual({ limit: "50" });
  });

  it("narrows to one entity from its row", async () => {
    const queries = recordQueries((params) =>
      cursorPage(params.has("entity_id") ? [] : [auditEntry()]),
    );
    const user = userEvent.setup();
    render(<AuditLog />);
    await user.click(
      await screen.findByRole("button", { name: "3f2a1b4c… — show only this entity" }),
    );
    expect(await screen.findByText("Nothing matches these filters")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Entity ID" })).toHaveValue(UUID_A);
    expect(screen.getByRole("textbox", { name: "Entity type" })).toHaveValue("discount");
    expect(Object.fromEntries(queries.at(-1) ?? [])).toEqual({
      entity_type: "discount",
      entity_id: UUID_A,
      limit: "50",
    });
  });

  it("shows the problem and retries", async () => {
    server.use(fail("get", PATH, { status: 403, title: "Forbidden", detail: "Admins only." }));
    const user = userEvent.setup();
    render(<AuditLog />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Admins only.");
    server.use(ok("get", PATH, cursorPage([auditEntry()])));
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table", { name: "Audit log" })).toBeInTheDocument();
  });

  it("loads older entries with the cursor", async () => {
    const queries = recordQueries((params) =>
      params.get("cursor") === "older"
        ? cursorPage([auditEntry({ id: "a2", action: "order.refunded" })])
        : cursorPage([auditEntry()], { next: "older" }),
    );
    const user = userEvent.setup();
    render(<AuditLog />);
    await screen.findByText("Showing 1 entries");
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("order.refunded")).toBeInTheDocument();
    expect(screen.getByText("Showing 2 entries")).toBeInTheDocument();
    expect(queries[1]?.get("cursor")).toBe("older");
  });
});
