import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { SignInForm } from "@/components/auth/sign-in-form";
import { router } from "@/test/navigation";
import { fail, on, server } from "@/test/server";

async function fillAndSubmit(email = "ada@example.com", password = "correct horse") {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Email"), email);
  await user.type(screen.getByLabelText("Password"), password);
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  return user;
}

describe("SignInForm", () => {
  it("sends the credentials and follows `next` on success", async () => {
    let sent: unknown;
    server.use(
      on("post", "/api/v1/auth/login", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({});
      }),
    );
    render(<SignInForm next="/account/orders" />);
    await fillAndSubmit();
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith("/account/orders");
    });
    expect(router.refresh).toHaveBeenCalled();
    expect(sent).toEqual({ email: "ada@example.com", password: "correct horse" });
  });

  it("skips the form when a silent refresh succeeds", async () => {
    server.use(on("post", "/api/v1/auth/refresh", () => HttpResponse.json({})));
    render(<SignInForm next="/account" />);
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith("/account");
    });
  });

  it("shows a generic message for wrong credentials, never which part was wrong", async () => {
    server.use(
      fail("post", "/api/v1/auth/login", {
        status: 401,
        slug: "invalid-credentials",
        title: "Invalid credentials",
      }),
    );
    render(<SignInForm next="/account" />);
    await fillAndSubmit();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Email or password is incorrect");
    expect(alert).toHaveFocus();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("tells a rate-limited visitor how long to wait", async () => {
    server.use(
      fail("post", "/api/v1/auth/login", {
        status: 429,
        slug: "too-many-attempts",
        title: "Too many attempts",
        headers: { "Retry-After": "840" },
      }),
    );
    render(<SignInForm next="/account" />);
    await fillAndSubmit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Try again in 14 minutes");
    expect(screen.getByRole("link", { name: "reset your password" })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
  });

  it("explains a suspended account using the problem detail", async () => {
    server.use(
      fail("post", "/api/v1/auth/login", {
        status: 403,
        slug: "account-suspended",
        title: "Suspended",
        detail: "Contact support.",
      }),
    );
    render(<SignInForm next="/account" />);
    await fillAndSubmit();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This account is suspended");
    expect(alert).toHaveTextContent("Contact support.");
  });

  it("falls back to the problem title for anything unexpected", async () => {
    server.use(
      fail("post", "/api/v1/auth/login", {
        status: 503,
        title: "Service unavailable",
        detail: "Try again shortly.",
      }),
    );
    render(<SignInForm next="/account" />);
    await fillAndSubmit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Service unavailable");
  });

  it("toggles password visibility with an accessible button", async () => {
    render(<SignInForm next="/account" />);
    const user = userEvent.setup();
    const password = screen.getByLabelText("Password");
    expect(password).toHaveAttribute("type", "password");
    await user.click(screen.getByRole("button", { name: "Show password" }));
    expect(password).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide password" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
