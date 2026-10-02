import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChangePasswordForm, ProfileForm } from "@/components/account/details-forms";
import { aUser } from "@/test/fixtures/account";
import { router } from "@/test/navigation";
import { fail, on, server } from "@/test/server";

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

describe("ProfileForm", () => {
  it("starts from the user's details", () => {
    render(<ProfileForm user={aUser({ phone: "+44 20 7946 0000", marketing_opt_in: true })} />);
    expect(screen.getByRole("textbox", { name: "First name (optional)" })).toHaveValue("Ada");
    expect(screen.getByRole("textbox", { name: "Last name (optional)" })).toHaveValue("Lovelace");
    expect(screen.getByRole("textbox", { name: "Phone (optional)" })).toHaveValue(
      "+44 20 7946 0000",
    );
    expect(screen.getByRole("checkbox", { name: /Email me about/ })).toBeChecked();
  });

  it("saves trimmed details, blanks as null, and refreshes the page", async () => {
    let sent: unknown;
    server.use(
      on("patch", "/api/v1/auth/me", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(aUser());
      }),
    );
    const user = userEvent.setup();
    render(<ProfileForm user={aUser({ first_name: null, last_name: null })} />);
    await user.type(screen.getByRole("textbox", { name: "First name (optional)" }), "  Grace ");
    await user.type(screen.getByRole("textbox", { name: "Last name (optional)" }), "   ");
    await user.click(screen.getByRole("checkbox", { name: /Email me about/ }));
    await user.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    expect(sent).toEqual({
      first_name: "Grace",
      last_name: null,
      phone: null,
      marketing_opt_in: true,
    });
    expect(toast.success).toHaveBeenCalledWith("Details saved", expect.anything());
  });

  it("shows field errors inline", async () => {
    server.use(
      fail("patch", "/api/v1/auth/me", {
        status: 422,
        slug: "validation-failed",
        errors: [{ field: "phone", code: "invalid", message: "Enter a valid phone number" }],
      }),
    );
    const user = userEvent.setup();
    render(<ProfileForm user={aUser()} />);
    const phone = screen.getByRole("textbox", { name: "Phone (optional)" });
    await user.type(phone, "abc");
    await user.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => {
      expect(phone).toHaveAccessibleDescription("Enter a valid phone number");
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("shows a form-level problem as an alert", async () => {
    server.use(
      fail("patch", "/api/v1/auth/me", { status: 500, title: "Server error", detail: "Later." }),
    );
    const user = userEvent.setup();
    render(<ProfileForm user={aUser()} />);
    await user.click(screen.getByRole("button", { name: "Save details" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Server errorLater.");
  });
});

describe("ChangePasswordForm", () => {
  it("changes the password and clears both fields", async () => {
    let sent: unknown;
    server.use(
      on("post", "/api/v1/auth/change-password", async ({ request }) => {
        sent = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    render(<ChangePasswordForm email="ada@example.com" />);
    const current = screen.getByLabelText("Current password");
    const next = screen.getByLabelText("New password");
    await user.type(current, "old secret!");
    await user.type(next, "correct horse battery");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() => {
      expect(next).toHaveValue("");
    });
    expect(current).toHaveValue("");
    expect(sent).toEqual({
      current_password: "old secret!",
      new_password: "correct horse battery",
    });
    expect(toast.success).toHaveBeenCalledWith(
      "Password changed. Your other devices have been signed out.",
      expect.anything(),
    );
  });

  it("flags a wrong current password and a rejected new one", async () => {
    server.use(
      fail("post", "/api/v1/auth/change-password", {
        status: 422,
        slug: "validation-failed",
        errors: [
          { field: "current_password", code: "wrong", message: "That is not your password" },
          { field: "password", code: "breached", message: "Found in a breach" },
        ],
      }),
    );
    const user = userEvent.setup();
    render(<ChangePasswordForm email="ada@example.com" />);
    await user.type(screen.getByLabelText("Current password"), "nope");
    await user.type(screen.getByLabelText("New password"), "password123");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText("That is not your password")).toBeInTheDocument();
    expect(screen.getByText("Found in a breach")).toBeInTheDocument();
    expect(screen.getByLabelText("Current password")).toHaveValue("nope");
  });

  it("shows other problems as an alert", async () => {
    server.use(
      fail("post", "/api/v1/auth/change-password", { status: 429, title: "Too many attempts" }),
    );
    const user = userEvent.setup();
    render(<ChangePasswordForm email="ada@example.com" />);
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many attempts");
  });
});
