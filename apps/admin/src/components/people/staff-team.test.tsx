import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { invitation, member } from "@/test/fixtures/people";
import { renderWithMe, staff } from "@/test/render";
import { fail, ok, on, server } from "@/test/server";

import { RequirePermission } from "./shared";
import { StaffTeam } from "./staff-team";

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", () => ({ toast, Toaster: () => null }));

const TEAM = "/api/v1/admin/staff";
const MEMBER = "/api/v1/admin/staff/{user_id}";
const INVITE = "/api/v1/admin/staff/invite";
const INVITATION = "/api/v1/admin/staff/invitations/{invitation_id}";

const ME = member({
  id: "00000000-0000-4000-8000-000000000001",
  email: "owner@velo.test",
  first_name: "Olu",
  last_name: "Owner",
  role: "owner",
});
const SAM = member();
const NAMELESS = member({
  id: "u3",
  email: "pending@velo.test",
  first_name: null,
  last_name: null,
  role: "fulfilment",
  status: "suspended",
});

function team(overrides: { invitations?: ReturnType<typeof invitation>[] } = {}) {
  return ok("get", TEAM, {
    members: [ME, SAM, NAMELESS],
    invitations: overrides.invitations ?? [invitation()],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("StaffTeam", () => {
  it("lists members and open invitations, marking the signed-in member", async () => {
    server.use(team());
    renderWithMe(<StaffTeam />);
    expect(screen.getByLabelText("Loading the team")).toBeInTheDocument();

    expect(await screen.findByRole("heading", { name: "Team (3)" })).toBeInTheDocument();
    const members = screen.getByRole("table", { name: "Team members" });
    const [, me, sam, nameless] = within(members).getAllByRole("row");
    if (!me || !sam || !nameless) throw new Error("rows missing");
    expect(me).toHaveTextContent("Olu Owner (you)");
    expect(sam).not.toHaveTextContent("(you)");
    expect(within(sam).getByText("sam@velo.test")).toBeInTheDocument();
    expect(within(sam).getByRole("combobox", { name: "Role for Sam Staff" })).toHaveValue("staff");
    expect(within(nameless).getByText("pending@velo.test")).toBeInTheDocument();
    expect(within(nameless).getByText("suspended")).toBeInTheDocument();
    expect(
      within(nameless).getByRole("combobox", { name: "Role for pending@velo.test" }),
    ).toHaveValue("fulfilment");

    const invitations = screen.getByRole("table", { name: "Open invitations" });
    expect(within(invitations).getByText("new@velo.test")).toBeInTheDocument();
    expect(within(invitations).getByText("Fulfilment")).toBeInTheDocument();
    // Every role is explained.
    for (const role of ["Fulfilment", "Staff", "Admin", "Owner"]) {
      expect(screen.getAllByText(role).length).toBeGreaterThan(0);
    }
    expect(screen.getByText("Everything, including the team and store settings.")).toBeVisible();
  });

  it("says when there are no open invitations", async () => {
    server.use(team({ invitations: [] }));
    renderWithMe(<StaffTeam />);
    expect(await screen.findByText("No open invitations")).toBeInTheDocument();
  });

  it("shows the problem when the team cannot be loaded, and retries", async () => {
    server.use(fail("get", TEAM, { status: 500, title: "Down", detail: "Try later." }));
    const user = userEvent.setup();
    renderWithMe(<StaffTeam />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Try later.");
    server.use(team());
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Team (3)" })).toBeInTheDocument();
  });

  it("is not shown, and not loaded, for a role without staff:manage", () => {
    renderWithMe(
      <RequirePermission permission="staff:manage" title="Staff">
        <StaffTeam />
      </RequirePermission>,
      { me: staff({ role: "admin", permissions: ["admin:access", "audit:read"] }) },
    );
    expect(screen.getByText("Your role does not include this page")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send invitation" })).not.toBeInTheDocument();
  });

  describe("inviting", () => {
    it("asks for an email before sending anything", async () => {
      server.use(team());
      const user = userEvent.setup();
      renderWithMe(<StaffTeam />);
      await user.click(screen.getByRole("button", { name: "Send invitation" }));
      expect(screen.getByRole("textbox", { name: "Email" })).toHaveAccessibleDescription(
        "Enter the email address to invite.",
      );
    });

    it("sends the email and role, and puts the invitation first, replacing an older one", async () => {
      let sent: unknown;
      server.use(
        team({ invitations: [invitation({ id: "old", email: "kim@velo.test" }), invitation()] }),
        on("post", INVITE, async ({ request }) => {
          sent = await request.json();
          return HttpResponse.json(
            invitation({ id: "i9", email: "kim@velo.test", role: "admin" }),
            { status: 201 },
          );
        }),
      );
      const user = userEvent.setup();
      renderWithMe(<StaffTeam />);
      await screen.findByRole("table", { name: "Open invitations" });

      const form = screen.getByRole("button", { name: "Send invitation" }).closest("form");
      if (!form) throw new Error("form missing");
      // The chosen role is explained under the form.
      expect(form).toHaveTextContent(
        "Fulfilment, plus the catalog, discounts, customers and reports.",
      );
      await user.type(screen.getByRole("textbox", { name: "Email" }), "  kim@velo.test ");
      await user.selectOptions(screen.getByRole("combobox", { name: "Role" }), "admin");
      expect(form).toHaveTextContent("Staff, plus refunds, customer notes and the audit log.");
      await user.click(screen.getByRole("button", { name: "Send invitation" }));

      await waitFor(() => {
        expect(screen.getByRole("textbox", { name: "Email" })).toHaveValue("");
      });
      expect(sent).toEqual({ email: "kim@velo.test", role: "admin" });
      const rows = within(screen.getByRole("table", { name: "Open invitations" })).getAllByRole(
        "row",
      );
      expect(rows).toHaveLength(3);
      expect(rows[1]).toHaveTextContent("kim@velo.test");
      expect(rows[1]).toHaveTextContent("Admin");
      expect(rows[2]).toHaveTextContent("new@velo.test");
      expect(toast.success).toHaveBeenCalledWith(
        "Invitation sent to kim@velo.test",
        expect.anything(),
      );
    });

    it("shows a field error inline", async () => {
      server.use(
        team(),
        fail("post", INVITE, {
          status: 409,
          title: "Conflict",
          errors: [{ field: "email", code: "taken", message: "Already on the team." }],
        }),
      );
      const user = userEvent.setup();
      renderWithMe(<StaffTeam />);
      await user.type(screen.getByRole("textbox", { name: "Email" }), "sam@velo.test");
      await user.click(screen.getByRole("button", { name: "Send invitation" }));
      await waitFor(() => {
        expect(screen.getByRole("textbox", { name: "Email" })).toHaveAccessibleDescription(
          "Already on the team.",
        );
      });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("shows any other problem above the form", async () => {
      server.use(
        team(),
        fail("post", INVITE, { status: 429, title: "Slow down", detail: "Too many invites." }),
      );
      const user = userEvent.setup();
      renderWithMe(<StaffTeam />);
      await user.type(screen.getByRole("textbox", { name: "Email" }), "x@velo.test");
      await user.click(screen.getByRole("button", { name: "Send invitation" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Too many invites.");
      expect(screen.getByRole("textbox", { name: "Email" })).toHaveValue("x@velo.test");
    });
  });

  describe("changing a role", () => {
    it("sends the new role and confirms it", async () => {
      let sent: unknown;
      server.use(
        team(),
        on("patch", MEMBER, async ({ request }) => {
          sent = await request.json();
          return HttpResponse.json({ ...SAM, role: "admin" });
        }),
      );
      const user = userEvent.setup();
      renderWithMe(<StaffTeam />);
      const select = await screen.findByRole("combobox", { name: "Role for Sam Staff" });
      await user.selectOptions(select, "admin");
      expect(select).toHaveValue("admin");
      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith(
          "Sam Staff is now admin. Their sessions were signed out so it takes effect.",
          expect.anything(),
        );
      });
      expect(sent).toEqual({ role: "admin" });
      expect(select).toBeEnabled();
    });

    it("names a nameless member by email", async () => {
      server.use(team(), ok("patch", MEMBER, { ...NAMELESS, role: "staff" }));
      const user = userEvent.setup();
      renderWithMe(<StaffTeam />);
      await user.selectOptions(
        await screen.findByRole("combobox", { name: "Role for pending@velo.test" }),
        "staff",
      );
      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith(
          expect.stringMatching(/^pending@velo\.test is now staff\./),
          expect.anything(),
        );
      });
    });

    it("rolls back, and explains the last-owner rule in full", async () => {
      server.use(
        team(),
        fail("patch", MEMBER, {
          status: 409,
          slug: "last-owner",
          title: "The store needs an owner",
          detail: "Make someone else owner first.",
        }),
      );
      const user = userEvent.setup();
      renderWithMe(<StaffTeam />);
      const select = await screen.findByRole("combobox", { name: "Role for Olu Owner" });
      await user.selectOptions(select, "staff");

      const message = "The store needs an owner. Make someone else owner first.";
      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(select).toHaveValue("owner");
      expect(toast.error).toHaveBeenCalledWith(message, expect.anything());
    });

    it("reads a last-owner problem without a detail as its title", async () => {
      server.use(
        team(),
        fail("patch", MEMBER, { status: 409, slug: "last-owner", title: "Needs an owner" }),
      );
      const user = userEvent.setup();
      renderWithMe(<StaffTeam />);
      await user.selectOptions(
        await screen.findByRole("combobox", { name: "Role for Olu Owner" }),
        "admin",
      );
      expect(await screen.findByRole("alert")).toHaveTextContent(/^Needs an owner\.$/);
    });

    it("shows other refusals by their detail", async () => {
      server.use(team(), fail("patch", MEMBER, { status: 403, title: "No", detail: "Not yours." }));
      const user = userEvent.setup();
      renderWithMe(<StaffTeam />);
      const select = await screen.findByRole("combobox", { name: "Role for Sam Staff" });
      await user.selectOptions(select, "owner");
      expect(await screen.findByRole("alert")).toHaveTextContent("Not yours.");
      expect(select).toHaveValue("staff");
    });
  });

  describe("revoking access", () => {
    it("confirms, demotes to customer, and removes the member", async () => {
      let sent: unknown;
      server.use(
        team(),
        on("patch", MEMBER, async ({ request }) => {
          sent = await request.json();
          return HttpResponse.json({ ...SAM, role: "customer" });
        }),
      );
      const user = userEvent.setup();
      renderWithMe(<StaffTeam />);
      const members = await screen.findByRole("table", { name: "Team members" });
      const samRow = within(members).getByText("Sam Staff").closest("tr");
      if (!samRow) throw new Error("row missing");
      await user.click(within(samRow).getByRole("button", { name: "Revoke access" }));

      const dialog = await screen.findByRole("dialog", {
        name: "Revoke admin access for Sam Staff?",
      });
      await user.click(within(dialog).getByRole("button", { name: "Revoke access" }));
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });
      expect(sent).toEqual({ role: "customer" });
      expect(screen.getByRole("heading", { name: "Team (2)" })).toBeInTheDocument();
      expect(screen.queryByText("Sam Staff")).not.toBeInTheDocument();
      expect(toast.success).toHaveBeenCalledWith(
        "Sam Staff no longer has admin access",
        expect.anything(),
      );
    });

    it("keeps the dialog open with the reason when refused", async () => {
      server.use(
        team(),
        fail("patch", MEMBER, {
          status: 409,
          slug: "last-owner",
          title: "The store needs an owner",
          detail: "Promote someone first.",
        }),
      );
      const user = userEvent.setup();
      renderWithMe(<StaffTeam />);
      const members = await screen.findByRole("table", { name: "Team members" });
      const nameless = within(members).getByText("pending@velo.test").closest("tr");
      if (!nameless) throw new Error("row missing");
      await user.click(within(nameless).getByRole("button", { name: "Revoke access" }));
      const dialog = await screen.findByRole("dialog", {
        name: "Revoke admin access for pending@velo.test?",
      });
      await user.click(within(dialog).getByRole("button", { name: "Revoke access" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(
        "The store needs an owner. Promote someone first.",
      );
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });
      expect(screen.getByRole("heading", { name: "Team (3)" })).toBeInTheDocument();
    });
  });

  describe("withdrawing an invitation", () => {
    it("confirms, withdraws it, and shows the empty state", async () => {
      let withdrawn: string | undefined;
      server.use(
        team(),
        on("delete", INVITATION, ({ params }) => {
          withdrawn = String(params["invitation_id"]);
          return new HttpResponse(null, { status: 204 });
        }),
      );
      const user = userEvent.setup();
      renderWithMe(<StaffTeam />);
      await user.click(await screen.findByRole("button", { name: "Withdraw" }));
      const dialog = await screen.findByRole("dialog", { name: "Withdraw this invitation?" });
      expect(dialog).toHaveTextContent("The link sent to new@velo.test stops working.");
      await user.click(within(dialog).getByRole("button", { name: "Withdraw" }));

      expect(await screen.findByText("No open invitations")).toBeInTheDocument();
      expect(withdrawn).toBe("i0000000-0000-4000-8000-000000000001");
      expect(toast.success).toHaveBeenCalledWith(
        "Invitation to new@velo.test withdrawn",
        expect.anything(),
      );
    });

    it("shows why a withdrawal failed", async () => {
      server.use(
        team(),
        fail("delete", INVITATION, { status: 404, title: "Gone", detail: "Already accepted." }),
      );
      const user = userEvent.setup();
      renderWithMe(<StaffTeam />);
      await user.click(await screen.findByRole("button", { name: "Withdraw" }));
      const dialog = await screen.findByRole("dialog", { name: "Withdraw this invitation?" });
      await user.click(within(dialog).getByRole("button", { name: "Withdraw" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("Already accepted.");
    });
  });
});
