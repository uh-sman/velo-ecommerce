import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import {
  ForgotPasswordForm,
  ResendVerification,
  ResetPasswordForm,
  VerifyEmail,
} from "@/components/auth/recovery-forms";
import { fail, on, server } from "@/test/server";

function capture(path: Parameters<typeof on>[1]) {
  const sent: unknown[] = [];
  server.use(
    on("post", path, async ({ request }) => {
      sent.push(await request.json());
      return HttpResponse.json({});
    }),
  );
  return sent;
}

describe("ForgotPasswordForm", () => {
  it("sends the email and confirms without revealing whether it exists", async () => {
    const sent = capture("/api/v1/auth/forgot-password");
    const user = userEvent.setup();
    render(<ForgotPasswordForm />);
    await user.type(screen.getByRole("textbox", { name: "Email" }), "ada@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Check your email");
    expect(status).toHaveTextContent("If an account exists for ada@example.com");
    expect(sent).toEqual([{ email: "ada@example.com" }]);
    expect(screen.getByRole("link", { name: "Back to sign in" })).toHaveAttribute(
      "href",
      "/sign-in",
    );
  });

  it("tells a rate-limited visitor how long to wait", async () => {
    server.use(
      fail("post", "/api/v1/auth/forgot-password", {
        status: 429,
        slug: "rate-limited",
        headers: { "Retry-After": "300" },
      }),
    );
    const user = userEvent.setup();
    render(<ForgotPasswordForm />);
    await user.type(screen.getByRole("textbox", { name: "Email" }), "ada@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Too many requests");
    expect(alert).toHaveTextContent("Try again in 5 minutes.");
  });

  it("says to try later when no wait is given", async () => {
    server.use(fail("post", "/api/v1/auth/forgot-password", { status: 429 }));
    const user = userEvent.setup();
    render(<ForgotPasswordForm />);
    await user.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Try again later.");
  });

  it("shows an email field error inline", async () => {
    server.use(
      fail("post", "/api/v1/auth/forgot-password", {
        status: 422,
        slug: "validation-failed",
        title: "Check the form",
        errors: [{ field: "email", code: "invalid", message: "Enter a valid email" }],
      }),
    );
    const user = userEvent.setup();
    render(<ForgotPasswordForm />);
    await user.type(screen.getByRole("textbox", { name: "Email" }), "nope");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Email" })).toHaveAccessibleDescription(
        "Enter a valid email",
      );
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Check the form");
  });
});

describe("ResetPasswordForm", () => {
  it("sends the token and the new password, then offers sign-in", async () => {
    const sent = capture("/api/v1/auth/reset-password");
    const user = userEvent.setup();
    render(<ResetPasswordForm token="tok-123" />);
    await user.type(screen.getByLabelText("New password"), "correct horse battery");
    await user.click(screen.getByRole("button", { name: "Set new password" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Your password has been changed");
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/sign-in");
    expect(sent).toEqual([{ token: "tok-123", password: "correct horse battery" }]);
  });

  it("explains a missing token without showing the form", () => {
    render(<ResetPasswordForm token="" />);
    expect(screen.getByRole("alert")).toHaveTextContent("This link is invalid or has expired");
    expect(screen.getByRole("alert")).toHaveTextContent("Reset links work once");
    expect(screen.getByRole("link", { name: "Send a new link" })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
  });

  it("switches to the invalid-link state when the API says the link expired", async () => {
    server.use(
      fail("post", "/api/v1/auth/reset-password", {
        status: 400,
        slug: "invalid-or-expired-link",
        title: "Expired",
      }),
    );
    const user = userEvent.setup();
    render(<ResetPasswordForm token="old" />);
    await user.type(screen.getByLabelText("New password"), "correct horse battery");
    await user.click(screen.getByRole("button", { name: "Set new password" }));
    expect(await screen.findByRole("link", { name: "Send a new link" })).toBeInTheDocument();
  });

  it("shows a password error inline without a duplicate alert", async () => {
    server.use(
      fail("post", "/api/v1/auth/reset-password", {
        status: 422,
        slug: "validation-failed",
        errors: [{ field: "password", code: "breached", message: "Found in a breach" }],
      }),
    );
    const user = userEvent.setup();
    render(<ResetPasswordForm token="tok" />);
    await user.type(screen.getByLabelText("New password"), "password123");
    await user.click(screen.getByRole("button", { name: "Set new password" }));
    expect(await screen.findByText("Found in a breach")).toBeInTheDocument();
    expect(screen.getByLabelText("New password")).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows other problems as an alert", async () => {
    server.use(
      fail("post", "/api/v1/auth/reset-password", {
        status: 500,
        title: "Server error",
        detail: "Please retry.",
      }),
    );
    const user = userEvent.setup();
    render(<ResetPasswordForm token="tok" />);
    await user.type(screen.getByLabelText("New password"), "correct horse battery");
    await user.click(screen.getByRole("button", { name: "Set new password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Server errorPlease retry.");
  });
});

describe("VerifyEmail", () => {
  it("confirms the address with a POST, exactly once", async () => {
    const sent = capture("/api/v1/auth/verify-email");
    render(<VerifyEmail token="verify-1" />);
    expect(screen.getByRole("status")).toHaveTextContent("Confirming your email address…");
    expect(await screen.findByText("Email confirmed")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to your account" })).toHaveAttribute(
      "href",
      "/account",
    );
    expect(sent).toEqual([{ token: "verify-1" }]);
  });

  it("offers a new link when the token is rejected", async () => {
    server.use(
      fail("post", "/api/v1/auth/verify-email", {
        status: 400,
        slug: "invalid-or-expired-link",
      }),
    );
    render(<VerifyEmail token="stale" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Verification links work once and expire after a day.",
    );
    expect(
      screen.getByRole("button", { name: "Send a new verification link" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Email" })).toBeInTheDocument();
  });

  it("goes straight to the invalid state without a token", () => {
    render(<VerifyEmail token="" />);
    expect(screen.getByRole("alert")).toHaveTextContent("This link is invalid or has expired");
  });
});

describe("ResendVerification", () => {
  it("asks for an email and confirms the send", async () => {
    const sent = capture("/api/v1/auth/resend-verification");
    const user = userEvent.setup();
    render(<ResendVerification />);
    await user.type(screen.getByRole("textbox", { name: "Email" }), "ada@example.com");
    await user.click(screen.getByRole("button", { name: "Send a new verification link" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "If ada@example.com still needs verifying",
    );
    expect(sent).toEqual([{ email: "ada@example.com" }]);
  });

  it("uses a known email without asking for it", async () => {
    const sent = capture("/api/v1/auth/resend-verification");
    const user = userEvent.setup();
    render(<ResendVerification defaultEmail="grace@example.com" />);
    expect(screen.queryByRole("textbox", { name: "Email" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send a new verification link" }));
    await screen.findByRole("status");
    expect(sent).toEqual([{ email: "grace@example.com" }]);
  });

  it("reports a failure", async () => {
    server.use(
      fail("post", "/api/v1/auth/resend-verification", {
        status: 429,
        headers: { "Retry-After": "30" },
      }),
    );
    const user = userEvent.setup();
    render(<ResendVerification defaultEmail="grace@example.com" />);
    await user.click(screen.getByRole("button", { name: "Send a new verification link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Try again in 30 seconds.");
  });
});
