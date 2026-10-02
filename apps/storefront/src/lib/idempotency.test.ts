import { describe, expect, it } from "vitest";

import type { Outcome } from "@/lib/api-browser";
import { AttemptKey } from "@/lib/idempotency";

function failure(status: number): Outcome<unknown> {
  return { ok: false, problem: { type: "https://velo.dev/errors/x", title: "x", status } };
}

describe("AttemptKey", () => {
  it("mints one key per attempt and keeps it until settled", () => {
    const key = new AttemptKey();
    const first = key.current;
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(key.current).toBe(first);
  });

  it("drops the key after a success", () => {
    const key = new AttemptKey();
    const first = key.current;
    key.settle({ ok: true, data: null });
    expect(key.current).not.toBe(first);
  });

  it.each([0, 409, 500, 503])("keeps the key for a retry after status %d", (status) => {
    const key = new AttemptKey();
    const first = key.current;
    key.settle(failure(status));
    expect(key.current).toBe(first);
  });

  it.each([400, 402, 422])("drops the key after a definitive %d", (status) => {
    const key = new AttemptKey();
    const first = key.current;
    key.settle(failure(status));
    expect(key.current).not.toBe(first);
  });
});
