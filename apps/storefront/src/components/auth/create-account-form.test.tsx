import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { CreateAccountForm } from "@/components/auth/create-account-form";
import { router } from "@/test/navigation";
import { fail, on, server } from "@/test/server";

async function fill({
  email = "ada@example.com",
  password = "correct horse battery",
  firstName = "",
  marketing = false,
} = {}) {
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox", { name: "Email" }), email);
  await user.type(screen.getByLabelText("Password"), password);
  if (firstName) await user.type(screen.getByRole("textbox", { name: /First name/ }), firstName);
  if (marketing) await user.click(screen.getByRole("checkbox", { name: /Email me about/ }));
  await user.click(screen.getByRole("button", { name: "Create account" }));
  return user;
}

describe("CreateAccountForm", () => {
  it("shows the password requirements before anything is typed", () => {
    render(<CreateAccountForm next="/account" />);
    expect(screen.getByText("At least 10 characters")).toBeInTheDocument();
    expect(screen.getByText("Not your email address")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Email me about/ })).not.toBeChecked();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/sign-in?next=%2Faccount",
    );
  });

  it("registers, signs in and returns the customer to where they were", async () => {
    let sent: unknown;
    server.use(
      on("post", "/api/v1/auth/register", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({}, { status: 201 });
      }),
    );
    render(<CreateAccountForm next="/checkout" />);
    await fill({ firstName: "  Ada ", marketing: true });
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith("/checkout");
    });
    expect(router.refresh).toHaveBeenCalled();
    expect(sent).toEqual({
      email: "ada@example.com",
      password: "correct horse battery",
      first_name: "Ada",
      marketing_opt_in: true,
    });
  });

  it("sends a blank first name as null and marketing off by default", async () => {
    let sent: unknown;
    server.use(
      on("post", "/api/v1/auth/register", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({}, { status: 201 });
      }),
    );
    render(<CreateAccountForm next="/account" />);
    await fill();
    await waitFor(() => {
      expect(sent).toMatchObject({ first_name: null, marketing_opt_in: false });
    });
  });

  it("offers sign-in when the email is taken, inline rather than as an alert", async () => {
    server.use(
      fail("post", "/api/v1/auth/register", {
        status: 409,
        slug: "email-taken",
        title: "Email taken",
      }),
    );
    render(<CreateAccountForm next="/cart" />);
    await fill();
    const email = screen.getByRole("textbox", { name: "Email" });
    await waitFor(() => {
      expect(email).toHaveAttribute("aria-invalid", "true");
    });
    expect(email).toHaveAccessibleDescription(
      expect.stringContaining("An account with this email already exists."),
    );
    expect(screen.getByRole("link", { name: "Sign in instead" })).toHaveAttribute(
      "href",
      "/sign-in?next=%2Fcart",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Create account" })).toBeEnabled();
  });

  it("shows field errors from a validation problem next to their fields", async () => {
    server.use(
      fail("post", "/api/v1/auth/register", {
        status: 422,
        slug: "validation-failed",
        title: "Invalid",
        errors: [
          {
            field: "password",
            code: "breached",
            message: "This password has appeared in a breach",
          },
          { field: "first_name", code: "too_long", message: "Too long" },
        ],
      }),
    );
    render(<CreateAccountForm next="/account" />);
    await fill({ firstName: "Ada" });
    expect(await screen.findByText("This password has appeared in a breach")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("textbox", { name: /First name/ })).toHaveAccessibleDescription(
      "Too long",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows any other problem as a focused alert", async () => {
    server.use(
      fail("post", "/api/v1/auth/register", {
        status: 503,
        title: "Service unavailable",
        detail: "Try again shortly.",
      }),
    );
    render(<CreateAccountForm next="/account" />);
    await fill();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Service unavailable");
    expect(alert).toHaveTextContent("Try again shortly.");
    expect(alert).toHaveFocus();
  });
});
