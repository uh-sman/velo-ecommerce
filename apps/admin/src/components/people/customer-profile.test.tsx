import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { customerDetail, note } from "@/test/fixtures/people";
import { renderWithMe, staff } from "@/test/render";
import { fail, ok, on, server } from "@/test/server";

import { CustomerProfile } from "./customer-profile";

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", () => ({ toast, Toaster: () => null }));

const ID = "c0000000-0000-4000-8000-000000000001";
const PATH = "/api/v1/admin/customers/{customer_id}";
const NOTES = "/api/v1/admin/customers/{customer_id}/notes";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CustomerProfile", () => {
  it("shows a skeleton, then the customer's summary, orders, contact and addresses", async () => {
    server.use(
      ok(
        "get",
        PATH,
        customerDetail({
          status: "suspended",
          recent_orders: [
            {
              id: "o1",
              number: "1001",
              status: "paid",
              placed_at: "2026-03-01T10:00:00Z",
              total: { amount: 4500, currency: "USD" },
            },
            { status: "", total: { amount: "bad" } },
          ],
          addresses: [
            {
              id: "addr1",
              first_name: "Ada",
              last_name: "Lovelace",
              line1: "1 Analytical Way",
              line2: null,
              city: "London",
              region: "",
              postal_code: 12345,
              country_code: "GB",
              is_default_shipping: true,
            },
            { line1: "2 Side St" },
          ],
        }),
      ),
    );
    renderWithMe(<CustomerProfile id={ID} />);
    expect(screen.getByLabelText("Loading customer")).toHaveAttribute("aria-busy", "true");

    expect(await screen.findByRole("heading", { name: "Ada Lovelace" })).toBeInTheDocument();
    expect(screen.getByText(/^Customer since .* · suspended$/)).toBeInTheDocument();
    expect(screen.getByText("$99.00")).toBeInTheDocument();

    const orders = screen.getByRole("table", { name: "Recent orders" });
    expect(within(orders).getByRole("link", { name: "#1001" })).toHaveAttribute(
      "href",
      "/orders/o1",
    );
    expect(within(orders).getByText("Confirmed")).toBeInTheDocument();
    expect(within(orders).getByText("$45.00")).toBeInTheDocument();
    // An order the API sent without a number or a readable total still links, and shows a dash.
    expect(within(orders).getByRole("link", { name: "View order" })).toHaveAttribute(
      "href",
      "/orders/1",
    );
    expect(within(orders).getAllByText("—").length).toBeGreaterThanOrEqual(2);

    expect(screen.getByRole("link", { name: "ada@example.com" })).toHaveAttribute(
      "href",
      "mailto:ada@example.com",
    );
    expect(screen.getByText("Verified")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "+15550100" })).toHaveAttribute(
      "href",
      "tel:+15550100",
    );
    expect(screen.getByText("Subscribed to marketing emails")).toBeInTheDocument();

    expect(screen.getByText("Default shipping")).toBeInTheDocument();
    expect(screen.getByText("1 Analytical Way")).toBeInTheDocument();
    expect(screen.getByText("London, 12345")).toBeInTheDocument();
    expect(screen.getByText("GB")).toBeInTheDocument();
    expect(screen.getByText("2 Side St")).toBeInTheDocument();
    expect(screen.getAllByText("Default shipping")).toHaveLength(1);
  });

  it("shows the empty states for a new, unverified customer without a name", async () => {
    server.use(
      ok(
        "get",
        PATH,
        customerDetail({
          first_name: null,
          last_name: null,
          email_verified: false,
          phone: null,
          marketing_opt_in: false,
          lifetime_value: null,
        }),
      ),
    );
    renderWithMe(<CustomerProfile id={ID} />);
    expect(await screen.findByRole("heading", { name: "ada@example.com" })).toBeInTheDocument();
    expect(screen.getByText(/^Customer since [^·]*$/)).toBeInTheDocument();
    expect(screen.getByText("No orders yet")).toBeInTheDocument();
    expect(screen.getByText("No saved addresses.")).toBeInTheDocument();
    expect(screen.getByText("Not verified")).toBeInTheDocument();
    expect(screen.getByText("No phone number")).toBeInTheDocument();
    expect(screen.getByText("Not subscribed to marketing emails")).toBeInTheDocument();
    expect(screen.getByText("No notes yet.")).toBeInTheDocument();
  });

  it("shows the problem when the customer cannot be loaded, and retries", async () => {
    server.use(fail("get", PATH, { status: 404, title: "Customer not found" }));
    const user = userEvent.setup();
    renderWithMe(<CustomerProfile id={ID} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Customer not found");
    expect(screen.getByRole("heading", { name: "Customer" })).toBeInTheDocument();

    server.use(ok("get", PATH, customerDetail()));
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Ada Lovelace" })).toBeInTheDocument();
  });

  describe("notes", () => {
    it("lists notes, with a stand-in for a deleted author", async () => {
      server.use(
        ok(
          "get",
          PATH,
          customerDetail({
            notes: [note(), note({ id: "n2", body: "Called about a return.", author_email: null })],
          }),
        ),
      );
      renderWithMe(<CustomerProfile id={ID} />);
      expect(await screen.findByText("Prefers email.")).toBeInTheDocument();
      expect(screen.getByText(/^owner@velo\.test · /)).toBeInTheDocument();
      expect(screen.getByText(/^Someone · /)).toBeInTheDocument();
    });

    it("refuses an empty note, and clears the message on typing", async () => {
      server.use(ok("get", PATH, customerDetail()));
      const user = userEvent.setup();
      renderWithMe(<CustomerProfile id={ID} />);
      await user.click(await screen.findByRole("button", { name: "Add note" }));
      const field = screen.getByRole("textbox", { name: "Add a note" });
      expect(field).toHaveAccessibleDescription(/Write the note first\./);
      expect(field).toHaveAttribute("aria-invalid", "true");
      await user.type(field, "x");
      expect(field).not.toHaveAttribute("aria-invalid");
    });

    it("adds a trimmed note to the top of the list", async () => {
      let sent: unknown;
      server.use(
        ok("get", PATH, customerDetail({ notes: [note()] })),
        on("post", NOTES, async ({ request }) => {
          sent = await request.json();
          return HttpResponse.json(note({ id: "n9", body: "VIP — ship fast." }), { status: 201 });
        }),
      );
      const user = userEvent.setup();
      renderWithMe(<CustomerProfile id={ID} />);
      const field = await screen.findByRole("textbox", { name: "Add a note" });
      await user.type(field, "  VIP — ship fast.  ");
      await user.click(screen.getByRole("button", { name: "Add note" }));

      expect(await screen.findByText("VIP — ship fast.")).toBeInTheDocument();
      expect(sent).toEqual({ body: "VIP — ship fast." });
      expect(field).toHaveValue("");
      const items = screen
        .getAllByRole("listitem")
        .filter((item) => item.textContent?.includes("·"));
      expect(items[0]).toHaveTextContent("VIP — ship fast.");
      expect(toast.success).toHaveBeenCalledWith("Note added", expect.anything());
    });

    it("shows the field error the API returns for the body", async () => {
      server.use(
        ok("get", PATH, customerDetail()),
        fail("post", NOTES, {
          status: 422,
          title: "Invalid",
          errors: [{ field: "body", message: "Too long.", code: "too_long" }],
        }),
      );
      const user = userEvent.setup();
      renderWithMe(<CustomerProfile id={ID} />);
      await user.type(await screen.findByRole("textbox", { name: "Add a note" }), "Hello");
      await user.click(screen.getByRole("button", { name: "Add note" }));
      expect(await screen.findByText("Too long.")).toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "Add a note" })).toHaveValue("Hello");
    });

    it("shows the problem detail for any other failure", async () => {
      server.use(
        ok("get", PATH, customerDetail()),
        fail("post", NOTES, { status: 403, title: "Forbidden", detail: "Notes need admin." }),
      );
      const user = userEvent.setup();
      renderWithMe(<CustomerProfile id={ID} />);
      await user.type(await screen.findByRole("textbox", { name: "Add a note" }), "Hello");
      await user.click(screen.getByRole("button", { name: "Add note" }));
      expect(await screen.findByText("Notes need admin.")).toBeInTheDocument();
    });

    it("hides the note form from a role without customers:write", async () => {
      server.use(ok("get", PATH, customerDetail({ notes: [note()] })));
      renderWithMe(<CustomerProfile id={ID} />, {
        me: staff({ role: "staff", permissions: ["admin:access", "customers:read"] }),
      });
      expect(await screen.findByText("Prefers email.")).toBeInTheDocument();
      expect(screen.queryByRole("textbox", { name: "Add a note" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Add note" })).not.toBeInTheDocument();
    });
  });
});
