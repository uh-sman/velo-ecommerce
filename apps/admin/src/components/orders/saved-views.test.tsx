import type { Schema } from "@velo/api-client";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toast } from "@/test/fixtures/orders";
import { fail, ok, on, server } from "@/test/server";

import type { OrderFilters } from "./order-filters";
import { SavedViews } from "./saved-views";

vi.mock("sonner", async () => (await import("@/test/fixtures/orders")).sonnerMock);

const VIEWS = "/api/v1/admin/saved-views" as const;
const VIEW = "/api/v1/admin/saved-views/{view_id}" as const;

function view(overrides: Partial<Schema<"ViewOut">> = {}): Schema<"ViewOut"> {
  return {
    id: "v1",
    name: "Big orders",
    scope: "orders",
    query: { min_total: 10000 },
    ...overrides,
  };
}

async function openViews(current: OrderFilters = {}) {
  const onApply = vi.fn();
  render(<SavedViews current={current} onApply={onApply} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Saved views" }));
  return { onApply, user };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SavedViews", () => {
  it("loads the operator's order views and marks the one in use", async () => {
    let scope: string | null = null;
    server.use(
      on("get", VIEWS, ({ request }) => {
        scope = new URL(request.url).searchParams.get("scope");
        return HttpResponse.json([
          view(),
          view({ id: "v2", name: "Unpaid", query: { payment_status: "pending" } }),
        ]);
      }),
    );
    await openViews({ min_total: "10000" });
    const current = await screen.findByRole("button", { name: /^Big orders/ });
    expect(current).toHaveAttribute("aria-current", "true");
    expect(current).toHaveTextContent("(current)");
    expect(screen.getByRole("button", { name: "Unpaid" })).not.toHaveAttribute("aria-current");
    expect(scope).toBe("orders");
  });

  it("says when there are none yet", async () => {
    server.use(ok("get", VIEWS, []));
    await openViews();
    expect(await screen.findByText(/None yet/)).toBeInTheDocument();
  });

  it("shows loading, then lets a failed load be retried", async () => {
    server.use(fail("get", VIEWS, { status: 500 }));
    await openViews();
    expect(await screen.findByText(/Could not load your views/)).toBeInTheDocument();
    server.use(ok("get", VIEWS, [view()]));
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Big orders" })).toBeInTheDocument();
  });

  it("applies a view and closes", async () => {
    server.use(ok("get", VIEWS, [view()]));
    const { user, onApply } = await openViews();
    await user.click(await screen.findByRole("button", { name: "Big orders" }));
    expect(onApply).toHaveBeenCalledWith({ min_total: "10000" });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Big orders" })).not.toBeInTheDocument();
    });
  });

  it("needs a name to save the current filters", async () => {
    server.use(ok("get", VIEWS, []));
    const { user } = await openViews();
    await user.click(screen.getByRole("button", { name: "Save" }));
    const input = screen.getByLabelText("Save current filters as");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Give the view a name.");
  });

  it("saves the current filters under a name", async () => {
    let sent: unknown;
    server.use(
      ok("get", VIEWS, []),
      on("post", VIEWS, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(view({ id: "v9", name: "Mine" }), { status: 201 });
      }),
    );
    const { user } = await openViews({ status: "paid" });
    await screen.findByText(/None yet/);
    await user.type(screen.getByLabelText("Save current filters as"), "  Mine ");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("button", { name: "Mine" })).toBeInTheDocument();
    expect(sent).toEqual({ scope: "orders", name: "Mine", query: { status: "paid" } });
    expect(screen.getByLabelText("Save current filters as")).toHaveValue("");
    expect(toast.success).toHaveBeenCalledWith("Saved “Mine”", expect.anything());
  });

  it("shows why a name was refused", async () => {
    server.use(
      ok("get", VIEWS, [view()]),
      fail("post", VIEWS, {
        status: 409,
        slug: "view-name-taken",
        title: "Name taken",
        errors: [{ field: "name", code: "taken", message: "You already have a view called that." }],
      }),
    );
    const { user } = await openViews();
    await user.type(screen.getByLabelText("Save current filters as"), "Big orders");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(screen.getByLabelText("Save current filters as")).toHaveAccessibleDescription(
        "You already have a view called that.",
      );
    });
  });

  it("falls back to the problem title when saving fails", async () => {
    server.use(ok("get", VIEWS, []), fail("post", VIEWS, { status: 500, title: "Server error" }));
    const { user } = await openViews();
    await user.type(screen.getByLabelText("Save current filters as"), "Mine");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Server error")).toBeInTheDocument();
  });

  it("deletes a view at once", async () => {
    server.use(ok("get", VIEWS, [view()]), ok("delete", VIEW, null, 204));
    const { user } = await openViews();
    await user.click(await screen.findByRole("button", { name: "Delete saved view Big orders" }));
    expect(screen.queryByRole("button", { name: "Big orders" })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Deleted “Big orders”", expect.anything());
    });
  });

  it("brings a view back when deleting fails", async () => {
    server.use(
      ok("get", VIEWS, [view()]),
      fail("delete", VIEW, { status: 500, title: "Server error" }),
    );
    const { user } = await openViews();
    await user.click(await screen.findByRole("button", { name: "Delete saved view Big orders" }));
    expect(await screen.findByRole("button", { name: "Big orders" })).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith(
      "Could not delete “Big orders”. Server error",
      expect.anything(),
    );
  });
});
