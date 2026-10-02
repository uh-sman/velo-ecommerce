import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { describeDevice, SessionsList } from "@/components/account/sessions-list";
import { aSession } from "@/test/fixtures/account";
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

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";

describe("describeDevice", () => {
  it.each([
    [null, "Unknown device", false],
    [
      "Mozilla/5.0 (Windows NT 10.0) Chrome/128.0 Safari/537.36 Edg/128.0",
      "Edge on Windows",
      false,
    ],
    ["Mozilla/5.0 (X11; Linux x86_64) Chrome/128.0 Safari/537.36 OPR/110", "Opera on Linux", false],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Firefox/130.0", "Firefox on macOS", false],
    [
      "Mozilla/5.0 (Linux; Android 14) Chrome/128.0 Mobile Safari/537.36",
      "Chrome on Android",
      true,
    ],
    [IPHONE, "Safari on iPhone", true],
    ["Mozilla/5.0 (iPad; CPU OS 17_0) Safari/604.1", "Safari on iPad", false],
    ["curl/8.0", "Browser on an unknown system", false],
  ])("%s → %s", (userAgent, label, mobile) => {
    expect(describeDevice(userAgent)).toEqual({ label, mobile });
  });
});

describe("SessionsList", () => {
  it("shows a loading state, then each session with the current one marked", async () => {
    server.use(
      ok("get", "/api/v1/auth/sessions", [
        aSession({ id: "current", is_current: true }),
        aSession({ id: "phone", user_agent: IPHONE, ip_address: null }),
      ]),
    );
    const { container } = render(<SessionsList />);
    expect(container.querySelector("[aria-busy]")).toBeInTheDocument();
    const items = await screen.findAllByRole("listitem");
    expect(items).toHaveLength(2);
    const [current, phone] = items as [HTMLElement, HTMLElement];
    expect(current).toHaveTextContent("Chrome on Windows");
    expect(current).toHaveTextContent("This device");
    expect(current).toHaveTextContent("203.0.113.7");
    // The current device signs out properly, not by revoking its own row.
    expect(within(current).getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(phone).toHaveTextContent("Unknown location");
    expect(
      within(phone).getByRole("button", { name: "Sign out Safari on iPhone" }),
    ).toBeInTheDocument();
  });

  it("revokes another session and removes it from the list", async () => {
    let revoked: string | undefined;
    server.use(
      ok("get", "/api/v1/auth/sessions", [
        aSession({ id: "current", is_current: true }),
        aSession({ id: "phone", user_agent: IPHONE }),
      ]),
      on("delete", "/api/v1/auth/sessions/{session_id}", ({ params }) => {
        revoked = String(params["session_id"]);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    render(<SessionsList />);
    await user.click(await screen.findByRole("button", { name: "Sign out Safari on iPhone" }));
    await waitFor(() => {
      expect(screen.getAllByRole("listitem")).toHaveLength(1);
    });
    expect(revoked).toBe("phone");
    expect(toast.success).toHaveBeenCalledWith("Signed out Safari on iPhone", expect.anything());
  });

  it("keeps the session and raises an error toast when revoking fails", async () => {
    server.use(
      ok("get", "/api/v1/auth/sessions", [aSession({ id: "phone", user_agent: IPHONE })]),
      fail("delete", "/api/v1/auth/sessions/{session_id}", {
        status: 404,
        title: "Session not found",
      }),
    );
    const user = userEvent.setup();
    render(<SessionsList />);
    await user.click(await screen.findByRole("button", { name: "Sign out Safari on iPhone" }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Session not found", expect.anything());
    });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("offers a retry when the list cannot load", async () => {
    server.use(fail("get", "/api/v1/auth/sessions", { status: 500 }));
    const user = userEvent.setup();
    render(<SessionsList />);
    expect(await screen.findByRole("alert")).toHaveTextContent("We could not load your sessions");
    server.use(ok("get", "/api/v1/auth/sessions", [aSession()]));
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findAllByRole("listitem")).toHaveLength(1);
  });
});
