import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { delay, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { SearchOverlay } from "@/components/shell/search-overlay";
import { RECENT_SEARCHES } from "@/lib/recent";
import { aProductCard, aSearchResult } from "@/test/fixtures/account";
import { router } from "@/test/navigation";
import { ok, on, server } from "@/test/server";

const BOOT = aProductCard({
  id: "boot",
  slug: "trail-boot",
  title: "Trail Boot",
  price: { amount: 15000, currency: "USD" },
  image: {
    id: "img-1",
    url: "https://cdn.example/boot.jpg",
    alt_text: null,
    blurhash: null,
    width: 800,
    height: 800,
    media_type: "image",
    renditions: [],
    variant_id: null,
  },
});
const SOCK = aProductCard({ id: "sock", slug: "wool-sock", title: "Wool Sock" });

async function openSearch() {
  const user = userEvent.setup();
  render(<SearchOverlay />);
  await user.click(screen.getByRole("button", { name: "Search" }));
  const dialog = await screen.findByRole("dialog", { name: "Search the store" });
  return { user, dialog, input: within(dialog).getByRole("combobox") };
}

function options() {
  return within(screen.getByRole("listbox", { name: "Search suggestions" })).queryAllByRole(
    "option",
  );
}

describe("SearchOverlay", () => {
  it("searches as you type, debounced, once the query has two characters", async () => {
    const queries: { q: string | null; limit: string | null }[] = [];
    server.use(
      on("get", "/api/v1/search", ({ request }) => {
        const params = new URL(request.url).searchParams;
        queries.push({ q: params.get("q"), limit: params.get("limit") });
        return HttpResponse.json(aSearchResult([BOOT, SOCK], { total_hits: 14 }));
      }),
    );
    const { user, input } = await openSearch();
    await user.type(input, "b");
    expect(options()).toHaveLength(0);
    await user.type(input, "oots");
    await waitFor(() => {
      expect(options()).toHaveLength(3);
    });
    // Typing faster than the 200 ms debounce sends only the final query.
    expect(queries).toEqual([{ q: "boots", limit: "6" }]);
    const [boot, sock, all] = options() as [HTMLElement, HTMLElement, HTMLElement];
    expect(boot).toHaveTextContent("Trail Boot");
    expect(boot).toHaveTextContent("$150.00");
    expect(sock).toHaveTextContent("Wool Sock");
    expect(all).toHaveTextContent("See all 14 results for “boots”");
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("14 results")).toBeInTheDocument();
  });

  it("ignores a slow response overtaken by a newer query", async () => {
    server.use(
      on("get", "/api/v1/search", async ({ request }) => {
        const q = new URL(request.url).searchParams.get("q");
        if (q === "bo") {
          await delay(400);
          return HttpResponse.json(aSearchResult([SOCK], { total_hits: 99 }));
        }
        return HttpResponse.json(aSearchResult([BOOT]));
      }),
    );
    const { user, input } = await openSearch();
    await user.type(input, "bo");
    // Let the first request go out, then type again while it is in flight.
    await act(() => new Promise((resolve) => setTimeout(resolve, 250)));
    expect(screen.getByText("Searching")).toBeInTheDocument();
    await user.type(input, "ot");
    await waitFor(() => {
      expect(options()[0]).toHaveTextContent("Trail Boot");
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(screen.queryByText("Wool Sock")).not.toBeInTheDocument();
    expect(options()).toHaveLength(2);
  });

  it("says so when nothing matches", async () => {
    server.use(ok("get", "/api/v1/search", aSearchResult([])));
    const { user, input } = await openSearch();
    await user.type(input, " zzz ");
    expect(
      await screen.findByText("No products match “zzz”. Try fewer words, or a different spelling."),
    ).toBeInTheDocument();
    expect(options()).toHaveLength(1);
    expect(options()[0]).toHaveTextContent("See all 0 results for “zzz”");
  });

  it("moves through options with the arrow keys and opens a product with Enter", async () => {
    server.use(ok("get", "/api/v1/search", aSearchResult([BOOT, SOCK])));
    const { user, input } = await openSearch();
    await user.type(input, "wool");
    await waitFor(() => {
      expect(options()).toHaveLength(3);
    });
    await user.keyboard("{ArrowDown}{ArrowDown}");
    const [, sock] = options() as [HTMLElement, HTMLElement, HTMLElement];
    expect(sock).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", sock.id);
    await user.keyboard("{ArrowDown}{ArrowDown}");
    // Wraps from the last option back to the first.
    expect(options()[0]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowUp}");
    expect(options()[2]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowUp}{Enter}");
    expect(router.push).toHaveBeenCalledWith("/products/wool-sock");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("searches in full with Enter and remembers the query", async () => {
    server.use(ok("get", "/api/v1/search", aSearchResult([BOOT])));
    const { user, input } = await openSearch();
    await user.type(input, "red boots{Enter}");
    expect(router.push).toHaveBeenCalledWith("/search?q=red%20boots");
    expect(JSON.parse(localStorage.getItem(RECENT_SEARCHES) ?? "[]")).toEqual(["red boots"]);
  });

  it("does nothing on Enter with an empty query", async () => {
    const { user } = await openSearch();
    await user.keyboard("{ArrowDown}{ArrowUp}{Enter}");
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("shows recent searches before typing, which can be chosen or cleared", async () => {
    localStorage.setItem(RECENT_SEARCHES, JSON.stringify(["socks", "boots"]));
    const { user, input } = await openSearch();
    expect(options().map((option) => option.textContent)).toEqual(["socks", "boots"]);
    expect(input).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(options()).toHaveLength(0);
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(JSON.parse(localStorage.getItem(RECENT_SEARCHES) ?? "null")).toEqual([]);
  });

  it("opens an option on click and highlights on hover", async () => {
    localStorage.setItem(RECENT_SEARCHES, JSON.stringify(["socks", "boots"]));
    const { user } = await openSearch();
    const [, boots] = options() as [HTMLElement, HTMLElement];
    await user.hover(boots);
    expect(boots).toHaveAttribute("aria-selected", "true");
    await user.click(boots);
    expect(router.push).toHaveBeenCalledWith("/search?q=boots");
    // Most recent first.
    expect(JSON.parse(localStorage.getItem(RECENT_SEARCHES) ?? "[]")).toEqual(["boots", "socks"]);
  });

  it("opens a product on click", async () => {
    server.use(ok("get", "/api/v1/search", aSearchResult([BOOT])));
    const { user, input } = await openSearch();
    await user.type(input, "boot");
    const boot = await screen.findByRole("option", { name: /Trail Boot/ });
    await user.click(boot);
    expect(router.push).toHaveBeenCalledWith("/products/trail-boot");
  });

  it("closes with the close button", async () => {
    const { user, dialog } = await openSearch();
    await user.click(within(dialog).getByRole("button", { name: "Close search" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("opens with the / shortcut, but not while typing in a field", async () => {
    render(
      <>
        <label>
          Note
          <input />
        </label>
        <SearchOverlay />
      </>,
    );
    expect(screen.getByRole("button", { name: "Search" })).toHaveAttribute(
      "aria-keyshortcuts",
      "/",
    );
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Note" }), { key: "/" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "x" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "/" });
    expect(await screen.findByRole("dialog", { name: "Search the store" })).toBeInTheDocument();
  });
});
