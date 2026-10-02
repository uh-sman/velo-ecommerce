import { render, screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { SessionRecovery } from "@/components/auth/session-recovery";
import { router, setNavigation } from "@/test/navigation";
import { on, server } from "@/test/server";

afterEach(async () => {
  // Let refreshSession forget its shared in-flight promise.
  await new Promise((resolve) => setTimeout(resolve, 0));
});

describe("SessionRecovery", () => {
  it("announces the check and re-renders signed in after a refresh", async () => {
    server.use(on("post", "/api/v1/auth/refresh", () => HttpResponse.json({})));
    render(<SessionRecovery />);
    expect(screen.getByRole("status")).toHaveTextContent("Checking your session…");
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("sends a visitor with no session to sign in, coming back here", async () => {
    setNavigation({ pathname: "/account/orders" });
    render(<SessionRecovery />);
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith("/sign-in?next=%2Faccount%2Forders");
    });
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("does nothing once unmounted", async () => {
    let release: () => void = () => undefined;
    let started = false;
    server.use(
      on("post", "/api/v1/auth/refresh", async () => {
        started = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return HttpResponse.json({});
      }),
    );
    const { unmount } = render(<SessionRecovery />);
    await waitFor(() => {
      expect(started).toBe(true);
    });
    unmount();
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(router.refresh).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });
});
