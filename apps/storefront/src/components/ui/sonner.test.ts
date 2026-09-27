import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

import { notify, TOAST_DURATION } from "./sonner";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("notify", () => {
  it("uses the spec's durations: 4s, 4s, 6s", () => {
    expect(TOAST_DURATION.success).toBe(4000);
    expect(TOAST_DURATION.info).toBe(4000);
    expect(TOAST_DURATION.warning).toBe(6000);
  });

  it("never auto-dismisses an error", () => {
    const spy = vi.spyOn(toast, "error");
    notify.error("Card declined");

    expect(spy).toHaveBeenCalledWith(
      "Card declined",
      expect.objectContaining({ duration: Number.POSITIVE_INFINITY, dismissible: true }),
    );
  });

  it("cannot be given a shorter duration per call", () => {
    const spy = vi.spyOn(toast, "success");
    // @ts-expect-error — duration is deliberately not an accepted option
    notify.success("Saved", { duration: 100 });

    expect(spy).toHaveBeenCalledWith("Saved", expect.objectContaining({ duration: 4000 }));
  });
});
