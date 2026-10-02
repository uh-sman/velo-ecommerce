import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Schema } from "@velo/api-client";
import { HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Badge,
  downloadCatalogExport,
  Pager,
  problemMessage,
  problemOf,
  ProductStatusBadge,
  productStatusLabel,
  rawApi,
  runBatch,
  saveBlob,
  StockBadge,
  TableSkeleton,
  useCursorList,
  useDebounced,
} from "@/components/catalog/shared";
import type { Outcome } from "@/lib/api-browser";
import { stockView } from "@/test/fixtures/catalog-editor";
import { offline, on, server } from "@/test/server";

type Pagination = Schema<"PaginationInfo">;

function pagination(overrides: Partial<Pagination> = {}): Pagination {
  return { has_more: false, limit: 25, next_cursor: null, ...overrides };
}

describe("badges", () => {
  it("label product statuses in words, falling back to the raw status", () => {
    expect(productStatusLabel("active")).toBe("Active");
    expect(productStatusLabel("draft")).toBe("Draft");
    expect(productStatusLabel("mystery")).toBe("mystery");
    render(
      <>
        <ProductStatusBadge status="archived" />
        <ProductStatusBadge status="mystery" />
        <Badge tone="danger" className="extra">
          Danger
        </Badge>
      </>,
    );
    expect(screen.getByText("Archived")).toHaveClass("text-warning");
    expect(screen.getByText("mystery")).toHaveClass("text-text-secondary");
    expect(screen.getByText("Danger")).toHaveClass("text-danger", "extra");
  });

  it.each([
    [stockView({ track_inventory: false }), "Not tracked"],
    [stockView({ available: 0 }), "Out of stock"],
    [stockView({ available: 0, allow_backorder: true }), "Backorder"],
    [stockView({ available: 3, reorder_point: 5 }), "Low stock"],
    [stockView({ available: 30 }), "In stock"],
  ])("StockBadge reads %#", (stock, label) => {
    render(<StockBadge stock={stock} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});

describe("problems", () => {
  it("prefers the detail and falls back to the title", () => {
    expect(problemMessage({ type: "t", title: "Title", status: 400, detail: "Detail" })).toBe(
      "Detail",
    );
    expect(problemMessage({ type: "t", title: "Title", status: 400 })).toBe("Title");
  });

  it("problemOf turns any failed response into a problem", async () => {
    expect((await problemOf(null)).status).toBe(0);
    const problem = { type: "https://velo.dev/errors/x", title: "X", status: 409 };
    expect(await problemOf(Response.json(problem, { status: 409 }))).toEqual(problem);
    expect(await problemOf(new Response("<html>", { status: 502 }))).toEqual({
      type: "https://velo.dev/errors/http-502",
      title: "Something went wrong",
      status: 502,
      detail: "Please try again.",
    });
    expect((await problemOf(Response.json({ nope: 1 }, { status: 500 }))).title).toBe(
      "Something went wrong",
    );
  });
});

describe("rawApi", () => {
  it("sends the CSRF token from the cookie, with credentials", async () => {
    document.cookie = "velo_csrf=from-cookie; path=/";
    let token: string | null = null;
    server.use(
      on("get", "/api/v1/admin/products/export", ({ request }) => {
        token = request.headers.get("X-CSRF-Token");
        return new HttpResponse("ok");
      }),
    );
    const response = await rawApi("/api/v1/admin/products/export");
    expect(response.status).toBe(200);
    expect(token).toBe("from-cookie");
  });

  it("fetches a CSRF token when there is no cookie", async () => {
    let token: string | null = null;
    server.use(
      on("post", "/api/v1/admin/products/bulk-import", ({ request }) => {
        token = request.headers.get("X-CSRF-Token");
        return new HttpResponse(null, { status: 202 });
      }),
    );
    await rawApi("/api/v1/admin/products/bulk-import", { method: "POST", body: "a,b" });
    expect(token).toBe("test-csrf");
  });

  it("refreshes once on 401 and retries", async () => {
    let calls = 0;
    server.use(
      on("post", "/api/v1/auth/refresh", () => HttpResponse.json({})),
      on("get", "/api/v1/admin/products/export", () => {
        calls += 1;
        return calls === 1 ? new HttpResponse(null, { status: 401 }) : new HttpResponse("ok");
      }),
    );
    const response = await rawApi("/api/v1/admin/products/export");
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("gives up on 401 when the session cannot be refreshed", async () => {
    server.use(
      on("get", "/api/v1/admin/products/export", () => new HttpResponse(null, { status: 401 })),
    );
    expect((await rawApi("/api/v1/admin/products/export")).status).toBe(401);
  });
});

describe("downloads", () => {
  const createObjectURL = vi.fn(() => "blob:velo/1");
  const revokeObjectURL = vi.fn();
  let clicked: HTMLAnchorElement[] = [];

  beforeEach(() => {
    clicked = [];
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("saveBlob clicks a temporary download link and revokes the URL later", () => {
    vi.useFakeTimers();
    saveBlob(new Blob(["x"]), "file.csv");
    expect(clicked).toHaveLength(1);
    expect(clicked[0]?.download).toBe("file.csv");
    expect(clicked[0]?.href).toBe("blob:velo/1");
    expect(document.querySelector("a[download]")).toBeNull();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:velo/1");
  });

  it("downloads the export under the server's filename", async () => {
    server.use(
      on(
        "get",
        "/api/v1/admin/products/export",
        () =>
          new HttpResponse("sku,price\n", {
            headers: { "Content-Disposition": 'attachment; filename="catalog-2026.csv"' },
          }),
      ),
    );
    expect(await downloadCatalogExport()).toBeNull();
    expect(clicked[0]?.download).toBe("catalog-2026.csv");
  });

  it("falls back to a default filename", async () => {
    server.use(on("get", "/api/v1/admin/products/export", () => new HttpResponse("sku\n")));
    expect(await downloadCatalogExport()).toBeNull();
    expect(clicked[0]?.download).toBe("velo-catalog.csv");
  });

  it("returns the problem's message when the export fails", async () => {
    server.use(
      on("get", "/api/v1/admin/products/export", () =>
        HttpResponse.json(
          { type: "https://velo.dev/errors/forbidden", title: "No", status: 403, detail: "Nope." },
          { status: 403 },
        ),
      ),
    );
    expect(await downloadCatalogExport()).toBe("Nope.");
    expect(clicked).toHaveLength(0);
  });

  it("reports a network failure", async () => {
    server.use(offline("get", "/api/v1/admin/products/export"));
    expect(await downloadCatalogExport()).toBe("Check your connection and try again.");
  });
});

describe("runBatch", () => {
  it("reports every item's outcome in order, at most `concurrency` at a time", async () => {
    let running = 0;
    let peak = 0;
    const results = await runBatch(
      [1, 2, 3, 4, 5],
      async (n) => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        if (n === 2) return "bad";
        if (n === 4) throw new Error("boom");
        return null;
      },
      2,
    );
    expect(peak).toBe(2);
    expect(results).toEqual([
      { item: 1, error: null },
      { item: 2, error: "bad" },
      { item: 3, error: null },
      { item: 4, error: "Check your connection and try again." },
      { item: 5, error: null },
    ]);
  });

  it("does nothing for no items", async () => {
    expect(await runBatch([], () => Promise.resolve(null))).toEqual([]);
  });
});

describe("useCursorList", () => {
  type Row = { id: string };
  type Fetch = (cursor: string | null) => Promise<Outcome<{ data: Row[]; pagination: Pagination }>>;

  it("loads, pages forward and back by cursor, reloads, and edits rows", async () => {
    const fetchPage = vi.fn<Fetch>((cursor) =>
      Promise.resolve({
        ok: true,
        data:
          cursor === null
            ? { data: [{ id: "a" }], pagination: pagination({ has_more: true, next_cursor: "c2" }) }
            : { data: [{ id: "b" }], pagination: pagination() },
      }),
    );
    const { result } = renderHook(() => useCursorList(fetchPage));
    expect(result.current.state.phase).toBe("loading");
    await waitFor(() => {
      expect(result.current.state.phase).toBe("ready");
    });
    expect(result.current.hasNext).toBe(true);
    expect(result.current.hasPrevious).toBe(false);

    act(() => {
      result.current.next();
    });
    await waitFor(() => {
      expect(result.current.page).toBe(2);
    });
    await waitFor(() => {
      const state = result.current.state;
      expect(state.phase === "ready" && state.rows[0]?.id).toBe("b");
    });
    expect(fetchPage).toHaveBeenLastCalledWith("c2");
    expect(result.current.hasNext).toBe(false);

    // No next cursor: next() is a no-op.
    act(() => {
      result.current.next();
    });
    expect(result.current.page).toBe(2);

    act(() => {
      result.current.previous();
    });
    expect(result.current.page).toBe(1);
    await waitFor(() => {
      expect(fetchPage).toHaveBeenLastCalledWith(null);
    });

    // At the first page, previous() is a no-op.
    act(() => {
      result.current.previous();
    });
    expect(result.current.page).toBe(1);

    const calls = fetchPage.mock.calls.length;
    act(() => {
      result.current.reload();
    });
    await waitFor(() => {
      expect(fetchPage).toHaveBeenCalledTimes(calls + 1);
    });
    await waitFor(() => {
      expect(result.current.state).toMatchObject({ phase: "ready", refreshing: false });
    });

    act(() => {
      result.current.setRows((rows) => [...rows, { id: "z" }]);
    });
    const state = result.current.state;
    expect(state.phase === "ready" && state.rows.map((r) => r.id)).toEqual(["a", "z"]);
  });

  it("reports a failed page as an error state and ignores setRows there", async () => {
    const problem = { type: "t", title: "Down", status: 503 };
    const fetchPage = vi.fn<Fetch>(() => Promise.resolve({ ok: false, problem }));
    const { result } = renderHook(() => useCursorList(fetchPage));
    await waitFor(() => {
      expect(result.current.state).toEqual({ phase: "error", problem });
    });
    expect(result.current.hasNext).toBe(false);
    act(() => {
      result.current.setRows(() => [{ id: "x" }]);
      result.current.next();
    });
    expect(result.current.state.phase).toBe("error");
  });

  it("drops a stale response superseded by a newer request", async () => {
    let resolveFirst: (value: Outcome<{ data: Row[]; pagination: Pagination }>) => void = () => {};
    const slow: Fetch = () =>
      new Promise((resolve) => {
        resolveFirst = resolve;
      });
    const fast: Fetch = () =>
      Promise.resolve({ ok: true, data: { data: [{ id: "fresh" }], pagination: pagination() } });
    const { result, rerender } = renderHook(({ fetchPage }) => useCursorList(fetchPage), {
      initialProps: { fetchPage: slow },
    });
    rerender({ fetchPage: fast });
    await waitFor(() => {
      expect(result.current.state.phase).toBe("ready");
    });
    await act(async () => {
      resolveFirst({ ok: true, data: { data: [{ id: "stale" }], pagination: pagination() } });
      await Promise.resolve();
    });
    const state = result.current.state;
    expect(state.phase === "ready" && state.rows[0]?.id).toBe("fresh");
  });
});

describe("Pager", () => {
  it("states the position and pages both ways", async () => {
    const user = userEvent.setup();
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    const { rerender } = render(
      <Pager
        page={2}
        pageSize={25}
        shown={10}
        total={35}
        hasPrevious
        hasNext={false}
        onPrevious={onPrevious}
        onNext={onNext}
        noun="products"
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Pagination" });
    expect(nav).toHaveTextContent("26–35 of 35 products");
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(onPrevious).toHaveBeenCalledOnce();

    rerender(
      <Pager
        page={1}
        pageSize={25}
        shown={25}
        total={null}
        hasPrevious={false}
        hasNext
        onPrevious={onPrevious}
        onNext={onNext}
        noun="products"
      />,
    );
    expect(nav).toHaveTextContent("1–25 products");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(onNext).toHaveBeenCalledOnce();

    rerender(
      <Pager
        page={1}
        pageSize={25}
        shown={0}
        total={0}
        hasPrevious={false}
        hasNext={false}
        onPrevious={onPrevious}
        onNext={onNext}
        noun="products"
      />,
    );
    expect(nav).toHaveTextContent("No products");
  });
});

describe("TableSkeleton", () => {
  it("is a labelled busy status with the requested rows", () => {
    render(<TableSkeleton rows={3} label="Loading products" />);
    const status = screen.getByRole("status", { name: "Loading products" });
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status.children).toHaveLength(4);
  });
});

describe("useDebounced", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles on the last value after the delay", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ value }) => useDebounced(value, 300), {
      initialProps: { value: "a" },
    });
    rerender({ value: "ab" });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    rerender({ value: "abc" });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe("a");
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe("abc");
  });
});
