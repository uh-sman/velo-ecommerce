import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EmailPreferences } from "@/components/email/preferences";
import { fail, ok, on, server } from "@/test/server";

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("sonner", () => ({ toast, Toaster: () => null }));

beforeEach(() => {
  vi.clearAllMocks();
});

const PREFS = { cart_reminders: true, marketing: false, order_updates: true };

describe("EmailPreferences", () => {
  it("shows order emails as always on, and the others as stored", async () => {
    server.use(ok("get", "/api/v1/account/preferences", PREFS));
    render(<EmailPreferences />);
    const orders = await screen.findByRole("checkbox", { name: "Order updates" });
    expect(orders).toBeChecked();
    expect(orders).toBeDisabled();
    expect(orders).toHaveAccessibleDescription(expect.stringContaining("Always on"));
    expect(screen.getByRole("checkbox", { name: "Cart reminders" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "News and offers" })).not.toBeChecked();
    expect(screen.getByRole("group", { name: "Emails we send you" })).toBeInTheDocument();
  });

  it("saves a toggle on change", async () => {
    let sent: unknown;
    server.use(
      ok("get", "/api/v1/account/preferences", PREFS),
      on("patch", "/api/v1/account/preferences", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({ ...PREFS, marketing: true });
      }),
    );
    const user = userEvent.setup();
    render(<EmailPreferences />);
    const marketing = await screen.findByRole("checkbox", { name: "News and offers" });
    await user.click(marketing);
    expect(marketing).toBeChecked();
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Saved", expect.anything());
    });
    expect(sent).toEqual({ marketing: true });
  });

  it("puts a toggle back when the save fails", async () => {
    server.use(
      ok("get", "/api/v1/account/preferences", PREFS),
      fail("patch", "/api/v1/account/preferences", { status: 500 }),
    );
    const user = userEvent.setup();
    render(<EmailPreferences />);
    const reminders = await screen.findByRole("checkbox", { name: "Cart reminders" });
    await user.click(reminders);
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "We could not save that. Please try again.",
        expect.anything(),
      );
    });
    expect(reminders).toBeChecked();
  });

  it("offers a retry when preferences cannot load", async () => {
    server.use(fail("get", "/api/v1/account/preferences", { status: 500 }));
    const user = userEvent.setup();
    render(<EmailPreferences />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We could not load your preferences",
    );
    server.use(ok("get", "/api/v1/account/preferences", PREFS));
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("checkbox", { name: "Cart reminders" })).toBeChecked();
  });
});
