import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, delay } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { SignInForm } from "@/components/auth/sign-in-form";
import { settleRefresh } from "@/test/fixtures/core";
import { router, setNavigation } from "@/test/navigation";
import { fail, on, server } from "@/test/server";

afterEach(settleRefresh);

async function fillAndSubmit(email = "olu@velo.test", password = "correct horse") {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Email"), email);
  await user.type(screen.getByLabelText("Password"), password);
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  return user;
}

describe("SignInForm", () => {
  it("sends the credentials and follows a safe `next` on success", async () => {
    setNavigation({ pathname: "/sign-in", search: { next: "/orders?status=paid" } });
    let sent: unknown;
    server.use(
      on("post", "/api/v1/auth/login", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({});
      }),
    );
    render(<SignInForm />);
    await fillAndSubmit();
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith("/orders?status=paid");
    });
    expect(router.refresh).toHaveBeenCalled();
    expect(sent).toEqual({ email: "olu@velo.test", password: "correct horse" });
  });

  it("ignores an off-site `next` and goes to the dashboard", async () => {
    setNavigation({ pathname: "/sign-in", search: { next: "https://evil.example" } });
    server.use(on("post", "/api/v1/auth/login", () => HttpResponse.json({})));
    render(<SignInForm />);
    await fillAndSubmit();
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith("/");
    });
  });

  it("skips the form when a silent refresh succeeds", async () => {
    setNavigation({ pathname: "/sign-in", search: { next: "/staff" } });
    server.use(on("post", "/api/v1/auth/refresh", () => new HttpResponse(null, { status: 204 })));
    render(<SignInForm />);
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith("/staff");
    });
  });

  it("stays on the form when there is no session to refresh", async () => {
    render(<SignInForm />);
    await settleRefresh();
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("shows the pending state while signing in", async () => {
    server.use(
      on("post", "/api/v1/auth/login", async () => {
        await delay(50);
        return HttpResponse.json({});
      }),
    );
    render(<SignInForm />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), "olu@velo.test");
    await user.type(screen.getByLabelText("Password"), "pw");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByRole("button", { name: /Sign in/ })).toHaveAttribute("aria-busy", "true");
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith("/");
    });
  });

  it("shows a generic message for wrong credentials and focuses it", async () => {
    server.use(
      fail("post", "/api/v1/auth/login", {
        status: 401,
        slug: "invalid-credentials",
        title: "Invalid credentials",
      }),
    );
    render(<SignInForm />);
    await fillAndSubmit();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Email or password is incorrect");
    expect(alert).toHaveFocus();
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("tells a rate-limited user how long to wait", async () => {
    server.use(
      fail("post", "/api/v1/auth/login", {
        status: 429,
        slug: "too-many-attempts",
        title: "Too many attempts",
        headers: { "Retry-After": "840" },
      }),
    );
    render(<SignInForm />);
    await fillAndSubmit();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Too many sign-in attempts");
    expect(alert).toHaveTextContent("Try again in 14 minutes.");
  });

  it("says 'later' when the rate limit gives no Retry-After", async () => {
    server.use(fail("post", "/api/v1/auth/login", { status: 429, slug: "too-many-attempts" }));
    render(<SignInForm />);
    await fillAndSubmit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Try again later.");
  });

  it("falls back to the problem's title and detail", async () => {
    server.use(
      fail("post", "/api/v1/auth/login", {
        status: 503,
        title: "Service unavailable",
        detail: "Try again shortly.",
      }),
    );
    render(<SignInForm />);
    await fillAndSubmit();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Service unavailable");
    expect(alert).toHaveTextContent("Try again shortly.");
  });

  it("links to the storefront's password reset", () => {
    render(<SignInForm />);
    expect(screen.getByRole("link", { name: "Forgot password?" })).toHaveAttribute(
      "href",
      "http://localhost:3000/forgot-password",
    );
  });

  it("marks both fields required for assistive tech", () => {
    render(<SignInForm />);
    expect(screen.getByLabelText("Email")).toBeRequired();
    expect(screen.getByLabelText("Password")).toBeRequired();
    expect(screen.getByLabelText("Email")).toHaveAttribute("type", "email");
  });
});
