import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { SignOutButton } from "@/components/auth/sign-out-button";
import { router } from "@/test/navigation";
import { fail, on, server } from "@/test/server";

describe("SignOutButton", () => {
  it("revokes the session server-side, then goes home", async () => {
    let csrf: string | null = null;
    server.use(
      on("post", "/api/v1/auth/logout", ({ request }) => {
        csrf = request.headers.get("X-CSRF-Token");
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    render(<SignOutButton variant="ghost" className="w-full" />);
    const button = screen.getByRole("button", { name: "Sign out" });
    await user.click(button);
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith("/");
    });
    expect(router.refresh).toHaveBeenCalled();
    expect(csrf).toBe("test-csrf");
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toBeDisabled();
  });

  it("still leaves the account area when the API cannot be reached", async () => {
    let refreshed = false;
    server.use(
      fail("post", "/api/v1/auth/logout", { status: 401, slug: "unauthenticated" }),
      on("post", "/api/v1/auth/refresh", () => {
        refreshed = true;
        return HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    render(<SignOutButton />);
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith("/");
    });
    // A dead session is not refreshed just to be signed out.
    expect(refreshed).toBe(false);
  });
});
