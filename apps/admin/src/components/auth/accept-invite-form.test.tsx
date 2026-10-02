import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { AcceptInviteForm } from "@/components/auth/accept-invite-form";
import { setNavigation } from "@/test/navigation";
import { fail, on, server } from "@/test/server";

function withToken(token = "invite-token") {
  setNavigation({ pathname: "/accept-invite", search: { token } });
}

describe("AcceptInviteForm", () => {
  it("explains a link without a token instead of showing the form", () => {
    setNavigation({ pathname: "/accept-invite" });
    render(<AcceptInviteForm />);
    expect(screen.getByRole("alert")).toHaveTextContent("This link is incomplete");
    expect(screen.queryByRole("button", { name: "Accept invitation" })).not.toBeInTheDocument();
  });

  it("accepts with names and a password, then links to sign-in", async () => {
    withToken();
    let sent: unknown;
    server.use(
      on("post", "/api/v1/staff-invitations/accept", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({});
      }),
    );
    render(<AcceptInviteForm />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("First name"), "Ada");
    await user.type(screen.getByLabelText("Last name"), "Lovelace");
    await user.type(screen.getByLabelText("Password"), "analytical engine");
    await user.click(screen.getByRole("button", { name: "Accept invitation" }));

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("You are on the team");
    expect(screen.getByRole("link", { name: "Sign in to the admin" })).toHaveAttribute(
      "href",
      "/sign-in",
    );
    expect(sent).toEqual({
      token: "invite-token",
      password: "analytical engine",
      first_name: "Ada",
      last_name: "Lovelace",
    });
  });

  it("sends nulls for an existing account that leaves everything empty", async () => {
    withToken("t2");
    let sent: unknown;
    server.use(
      on("post", "/api/v1/staff-invitations/accept", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({});
      }),
    );
    render(<AcceptInviteForm />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Accept invitation" }));
    await screen.findByRole("status");
    expect(sent).toEqual({ token: "t2", password: null, first_name: null, last_name: null });
  });

  it("shows a password field error inline", async () => {
    withToken();
    server.use(
      fail("post", "/api/v1/staff-invitations/accept", {
        status: 422,
        slug: "validation-failed",
        title: "Invalid",
        errors: [{ field: "password", code: "too_short", message: "Use at least 10 characters." }],
      }),
    );
    render(<AcceptInviteForm />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Password"), "short");
    await user.click(screen.getByRole("button", { name: "Accept invitation" }));

    expect(await screen.findByText("Use at least 10 characters.")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the problem detail for an expired invitation", async () => {
    withToken();
    server.use(
      fail("post", "/api/v1/staff-invitations/accept", {
        status: 410,
        slug: "invitation-expired",
        title: "Expired",
        detail: "This invitation has expired. Ask for a new one.",
      }),
    );
    render(<AcceptInviteForm />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Accept invitation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This invitation has expired. Ask for a new one.",
    );
  });

  it("falls back to the problem title without a detail", async () => {
    withToken();
    server.use(
      fail("post", "/api/v1/staff-invitations/accept", { status: 404, title: "Not found" }),
    );
    render(<AcceptInviteForm />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Accept invitation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Not found");
  });
});
