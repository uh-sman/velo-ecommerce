import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { discountView } from "@/test/fixtures/people";
import { fail, ok, on, server } from "@/test/server";

import { DiscountList, DiscountStatusBadge } from "./discount-list";

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", () => ({ toast, Toaster: () => null }));

const LIST = "/api/v1/admin/discounts";
const ONE = "/api/v1/admin/discounts/{discount_id}";

const UNUSED = discountView();
const USED = discountView({
  id: "d2",
  code: null,
  title: "Free shipping over $50",
  type: "free_shipping",
  value: "0",
  times_redeemed: 3,
  max_redemptions: 100,
  ends_at: "2026-12-31T00:00:00Z",
});

beforeEach(() => {
  vi.clearAllMocks();
});

function rowOf(name: string): HTMLElement {
  const row = screen.getByRole("link", { name: new RegExp(name) }).closest("tr");
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

describe("DiscountStatusBadge", () => {
  it("labels every status", () => {
    const { rerender } = render(<DiscountStatusBadge status="active" />);
    expect(screen.getByText("Active")).toBeInTheDocument();
    for (const [status, label] of [
      ["scheduled", "Scheduled"],
      ["expired", "Expired"],
      ["used_up", "Used up"],
      ["inactive", "Inactive"],
    ] as const) {
      rerender(<DiscountStatusBadge status={status} />);
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});

describe("DiscountList", () => {
  it("lists discounts with their value, status, usage and dates", async () => {
    const urls: URL[] = [];
    server.use(
      on("get", LIST, ({ request }) => {
        urls.push(new URL(request.url));
        return HttpResponse.json([UNUSED, USED]);
      }),
    );
    render(<DiscountList />);
    expect(screen.getByLabelText("Loading discounts")).toBeInTheDocument();
    await screen.findByRole("table", { name: "Discounts" });

    const spring = rowOf("SPRING20");
    expect(within(spring).getByRole("link")).toHaveAttribute(
      "href",
      "/discounts/d0000000-0000-4000-8000-000000000001",
    );
    expect(spring).toHaveTextContent("Spring sale");
    expect(spring).toHaveTextContent("20% off");
    expect(spring).toHaveTextContent("Active");
    expect(spring).toHaveTextContent("no end");
    expect(within(spring).getByRole("button", { name: "Delete SPRING20" })).toBeInTheDocument();

    const automatic = rowOf("Automatic");
    expect(automatic).toHaveTextContent("Free shipping");
    expect(automatic).toHaveTextContent("3 / 100");
    expect(automatic).not.toHaveTextContent("no end");
    expect(
      within(automatic).getByRole("button", { name: "Deactivate Free shipping over $50" }),
    ).toBeInTheDocument();

    expect(urls).toHaveLength(1);
    expect([...(urls[0]?.searchParams.keys() ?? [])]).toEqual([]);
  });

  it("invites creating the first discount when there are none", async () => {
    server.use(ok("get", LIST, []));
    render(<DiscountList />);
    expect(await screen.findByText("No discounts yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create the first discount" })).toHaveAttribute(
      "href",
      "/discounts/new",
    );
  });

  it("filters by a settled search and by status", async () => {
    const urls: URL[] = [];
    server.use(
      on("get", LIST, ({ request }) => {
        const url = new URL(request.url);
        urls.push(url);
        return HttpResponse.json(url.search ? [] : [UNUSED]);
      }),
    );
    const user = userEvent.setup();
    render(<DiscountList />);
    await screen.findByRole("table", { name: "Discounts" });

    await user.type(
      screen.getByRole("searchbox", { name: "Search discounts by code or title" }),
      " summer ",
    );
    expect(await screen.findByText("No discounts match")).toBeInTheDocument();
    expect(screen.getByText("Try another search or status.")).toBeInTheDocument();
    expect(urls.at(-1)?.searchParams.get("q")).toBe("summer");

    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "expired");
    await waitFor(() => {
      expect(urls.at(-1)?.searchParams.get("status")).toBe("expired");
    });
    expect(urls.at(-1)?.searchParams.get("q")).toBe("summer");
  });

  it("shows the problem and retries", async () => {
    server.use(fail("get", LIST, { status: 500, title: "Broken", detail: "Database away." }));
    const user = userEvent.setup();
    render(<DiscountList />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Database away.");
    server.use(ok("get", LIST, [UNUSED]));
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table", { name: "Discounts" })).toBeInTheDocument();
  });

  it("deletes a discount that was never used", async () => {
    let deleted: string | undefined;
    server.use(
      ok("get", LIST, [UNUSED, USED]),
      on("delete", ONE, ({ params }) => {
        deleted = String(params["discount_id"]);
        return HttpResponse.json({ outcome: "deleted" });
      }),
    );
    const user = userEvent.setup();
    render(<DiscountList />);
    await screen.findByRole("table", { name: "Discounts" });
    await user.click(screen.getByRole("button", { name: "Delete SPRING20" }));

    const dialog = await screen.findByRole("dialog", { name: "Remove SPRING20?" });
    expect(dialog).toHaveTextContent("It has never been used, so it will be deleted completely.");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(screen.queryByRole("link", { name: /SPRING20/ })).not.toBeInTheDocument();
    });
    expect(deleted).toBe(UNUSED.id);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith("SPRING20 deleted", expect.anything());
  });

  it("deactivates a used discount instead of deleting it", async () => {
    server.use(ok("get", LIST, [UNUSED, USED]), ok("delete", ONE, { outcome: "deactivated" }));
    const user = userEvent.setup();
    render(<DiscountList />);
    await screen.findByRole("table", { name: "Discounts" });
    await user.click(screen.getByRole("button", { name: "Deactivate Free shipping over $50" }));

    const dialog = await screen.findByRole("dialog", { name: "Remove Free shipping over $50?" });
    expect(dialog).toHaveTextContent("It has been used 3 times, so it will be kept");
    await user.click(within(dialog).getByRole("button", { name: "Deactivate" }));

    await waitFor(() => {
      expect(rowOf("Automatic")).toHaveTextContent("Inactive");
    });
    expect(rowOf("SPRING20")).toHaveTextContent("Active");
    expect(toast.success).toHaveBeenCalledWith(
      "Free shipping over $50 had been used, so it was deactivated rather than deleted",
      expect.anything(),
    );
  });

  it("keeps the dialog open with the reason when removal fails", async () => {
    server.use(
      ok("get", LIST, [UNUSED]),
      fail("delete", ONE, { status: 409, title: "Conflict", detail: "It was just redeemed." }),
    );
    const user = userEvent.setup();
    render(<DiscountList />);
    await user.click(await screen.findByRole("button", { name: "Delete SPRING20" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("It was just redeemed.");

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(rowOf("SPRING20")).toBeInTheDocument();
  });
});
