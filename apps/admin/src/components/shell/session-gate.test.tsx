import { render, screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { SessionGate } from "@/components/shell/session-gate";
import { settleRefresh } from "@/test/fixtures/core";
import { router, setNavigation } from "@/test/navigation";
import { on, server } from "@/test/server";

afterEach(settleRefresh);

describe("SessionGate", () => {
  it("tells the user it is checking their session", async () => {
    render(<SessionGate />);
    expect(screen.getByRole("status")).toHaveTextContent("Checking your session…");
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalled();
    });
  });

  it("re-renders the page when the session can be renewed", async () => {
    server.use(on("post", "/api/v1/auth/refresh", () => new HttpResponse(null, { status: 204 })));
    render(<SessionGate />);
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalledOnce();
    });
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("sends the user to sign in and back when there is nothing to renew", async () => {
    setNavigation({ pathname: "/orders/42" });
    render(<SessionGate />);
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith("/sign-in?next=%2Forders%2F42");
    });
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("does nothing once unmounted", async () => {
    let answer: (() => void) | undefined;
    server.use(
      on(
        "post",
        "/api/v1/auth/refresh",
        () =>
          new Promise<Response>((resolve) => {
            answer = () => {
              resolve(new HttpResponse(null, { status: 204 }));
            };
          }),
      ),
    );
    const { unmount } = render(<SessionGate />);
    await waitFor(() => {
      expect(answer).toBeDefined();
    });
    unmount();
    answer?.();
    await settleRefresh();
    await settleRefresh();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });
});
