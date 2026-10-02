import { afterEach, describe, expect, it, vi } from "vitest";

import { forget, recall, RECENT_SEARCHES, remember } from "@/lib/recent";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recent", () => {
  it("keeps the most recent first, without duplicates, capped at the limit", () => {
    remember(RECENT_SEARCHES, "boots", 3);
    remember(RECENT_SEARCHES, "socks", 3);
    remember(RECENT_SEARCHES, "  boots ", 3);
    remember(RECENT_SEARCHES, "hats", 3);
    expect(remember(RECENT_SEARCHES, "gloves", 3)).toEqual(["gloves", "hats", "boots"]);
    expect(recall(RECENT_SEARCHES)).toEqual(["gloves", "hats", "boots"]);
  });

  it("ignores blank values", () => {
    remember(RECENT_SEARCHES, "boots", 3);
    expect(remember(RECENT_SEARCHES, "   ", 3)).toEqual(["boots"]);
  });

  it("forgets everything", () => {
    remember(RECENT_SEARCHES, "boots", 3);
    forget(RECENT_SEARCHES);
    expect(recall(RECENT_SEARCHES)).toEqual([]);
  });

  it("treats corrupt or foreign data as an empty list", () => {
    localStorage.setItem(RECENT_SEARCHES, "{not json");
    expect(recall(RECENT_SEARCHES)).toEqual([]);
    localStorage.setItem(RECENT_SEARCHES, JSON.stringify({ a: 1 }));
    expect(recall(RECENT_SEARCHES)).toEqual([]);
    localStorage.setItem(RECENT_SEARCHES, JSON.stringify(["ok", 3, null, "fine"]));
    expect(recall(RECENT_SEARCHES)).toEqual(["ok", "fine"]);
  });

  it("returns an empty list when storage is unavailable", () => {
    const boom = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(boom);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(boom);
    expect(remember(RECENT_SEARCHES, "boots", 3)).toEqual(["boots"]);
    expect(recall(RECENT_SEARCHES)).toEqual([]);
  });
});
