import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import {
  EmailSettings,
  PaymentProviders,
  StoreSettings,
} from "@/components/settings/general-settings";
import { settings } from "@/test/fixtures/core";
import { fail, ok, on, server } from "@/test/server";

// The Toaster needs a real matchMedia; assert on the toast calls instead.
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

async function toasted(message: string) {
  await waitFor(() => {
    expect(toast.success).toHaveBeenCalledWith(message, expect.anything());
  });
}

/** A `<Section>` by its heading (sections are not labelled landmarks). */
function section(name: string | RegExp) {
  const element = screen.getByRole("heading", { name }).closest("section");
  if (!element) throw new Error("heading is not inside a section");
  return within(element);
}

async function findSection(name: string | RegExp) {
  await screen.findByRole("heading", { name });
  return section(name);
}

function withSettings(value = settings()) {
  toast.success.mockClear();
  server.use(ok("get", "/api/v1/admin/settings", value));
}

describe("StoreSettings", () => {
  it("loads the store details into the form, with the fixed settings beside it", async () => {
    withSettings();
    render(<StoreSettings />);
    expect(screen.getByLabelText("Loading settings")).toHaveAttribute("aria-busy", "true");
    expect(await screen.findByLabelText("Store name")).toHaveValue("Velo Cycles");
    expect(screen.getByLabelText("Support email")).toHaveValue("help@velo.test");
    expect(screen.getByLabelText("Phone (optional)")).toHaveValue("+1 555 0100");
    expect(screen.getByLabelText("Address")).toHaveValue("1 Market St\nSan Francisco");
    const fixed = section("Fixed settings");
    expect(fixed.getByText("USD")).toBeInTheDocument();
    expect(fixed.getByText("30 days")).toBeInTheDocument();
  });

  it("shows dashes and empty fields for missing values", async () => {
    withSettings(
      settings({
        store: {
          name: null,
          support_email: undefined,
          phone: 42,
          address: "not a list",
          currency: null,
          return_window_days: null,
        },
      }),
    );
    render(<StoreSettings />);
    expect(await screen.findByLabelText("Store name")).toHaveValue("");
    expect(screen.getByLabelText("Phone (optional)")).toHaveValue("42");
    expect(screen.getByLabelText("Address")).toHaveValue("");
    const fixed = section("Fixed settings");
    expect(fixed.getAllByText("—")).toHaveLength(2);
  });

  it("saves trimmed details and confirms", async () => {
    let sent: unknown;
    withSettings();
    server.use(
      on("patch", "/api/v1/admin/settings/store", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({ ...settings().store, name: "Velo Bikes" });
      }),
    );
    render(<StoreSettings />);
    const user = userEvent.setup();
    const name = await screen.findByLabelText("Store name");
    await user.clear(name);
    await user.type(name, "  Velo Bikes ");
    await user.clear(screen.getByLabelText("Phone (optional)"));
    await user.type(screen.getByLabelText("Address"), "\n\n  CA 94105  ");
    await user.click(screen.getByRole("button", { name: "Save store details" }));
    await toasted("Store details saved");
    expect(sent).toEqual({
      name: "Velo Bikes",
      support_email: "help@velo.test",
      phone: "",
      address: ["1 Market St", "San Francisco", "CA 94105"],
    });
  });

  it("refuses more than six address lines before calling the API", async () => {
    withSettings(settings({ store: { address: [] } }));
    render(<StoreSettings />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Address"), "1\n2\n3\n4\n5\n6\n7");
    await user.click(screen.getByRole("button", { name: "Save store details" }));
    expect(await screen.findByText("At most 6 lines.")).toBeInTheDocument();
    expect(screen.getByLabelText("Address")).toHaveAttribute("aria-invalid", "true");
  });

  it("puts field errors on their fields, numbering an address line", async () => {
    withSettings();
    server.use(
      fail("patch", "/api/v1/admin/settings/store", {
        status: 422,
        slug: "validation-failed",
        title: "Invalid",
        errors: [
          { field: "support_email", code: "invalid", message: "Enter an email address" },
          { field: "address.1", code: "too_long", message: "Too long" },
        ],
      }),
    );
    render(<StoreSettings />);
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Save store details" }));
    expect(await screen.findByText("Enter an email address")).toBeInTheDocument();
    expect(screen.getByText("Line 2: Too long")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a whole-address error as is", async () => {
    withSettings();
    server.use(
      fail("patch", "/api/v1/admin/settings/store", {
        status: 422,
        errors: [{ field: "address", code: "required", message: "Add an address" }],
      }),
    );
    render(<StoreSettings />);
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Save store details" }));
    expect(await screen.findByText("Add an address")).toBeInTheDocument();
  });

  it("shows any other problem above the form", async () => {
    withSettings();
    server.use(
      fail("patch", "/api/v1/admin/settings/store", {
        status: 403,
        title: "Forbidden",
        detail: "Only owners can change the store.",
      }),
    );
    render(<StoreSettings />);
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Save store details" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only owners can change the store.");
  });

  it("shows a load error and retries", async () => {
    server.use(fail("get", "/api/v1/admin/settings", { status: 500, title: "Settings down" }));
    render(<StoreSettings />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Settings down");
    withSettings();
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("Store name")).toHaveValue("Velo Cycles");
  });
});

describe("EmailSettings", () => {
  it("previews the confirmation email and switches to the shipped one", async () => {
    withSettings();
    render(<EmailSettings />);
    const preview = await findSection("Preview");
    expect(
      preview.getByText(/From Velo Cycles · Subject: Order #1042 confirmed/),
    ).toBeInTheDocument();
    expect(preview.getByText("Thanks for your order!")).toBeInTheDocument();
    expect(preview.getByText("The Velo team")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(preview.getByRole("button", { name: "Shipped" }));
    expect(preview.getByRole("button", { name: "Shipped" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(preview.getByText(/Order #1042 has shipped/)).toBeInTheDocument();
    expect(preview.getByText("It is on its way.")).toBeInTheDocument();
    expect(preview.getByText("[Tracking link and the items in this parcel]")).toBeInTheDocument();

    await user.click(preview.getByRole("button", { name: "Confirmed" }));
    expect(preview.getByText("Thanks for your order!")).toBeInTheDocument();
  });

  it("follows the field being edited and updates live", async () => {
    withSettings(settings({ store: { name: "" }, emails: { order_shipped_intro: "" } }));
    render(<EmailSettings />);
    const user = userEvent.setup();
    const shipped = await screen.findByLabelText("Order shipped — opening line");
    const preview = section("Preview");
    expect(preview.getByText(/From your store/)).toBeInTheDocument();

    await user.click(shipped);
    expect(preview.getByText("(no opening line)")).toBeInTheDocument();
    await user.type(shipped, "Out the door");
    expect(preview.getByText("Out the door")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Order confirmed — opening line"));
    expect(preview.getByText("Thanks for your order!")).toBeInTheDocument();
  });

  it("saves the trimmed texts", async () => {
    let sent: unknown;
    withSettings();
    server.use(
      on("patch", "/api/v1/admin/settings/emails", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({ ...settings().emails, signature: "Cheers" });
      }),
    );
    render(<EmailSettings />);
    const user = userEvent.setup();
    const signature = await screen.findByLabelText("Signature");
    await user.clear(signature);
    await user.type(signature, "  Cheers ");
    await user.type(screen.getByLabelText("Order confirmed — opening line"), " See you soon.");
    await user.click(screen.getByRole("button", { name: "Save email texts" }));
    await toasted("Email texts saved");
    expect(sent).toEqual({
      order_confirmed_intro: "Thanks for your order! See you soon.",
      order_shipped_intro: "It is on its way.",
      signature: "Cheers",
    });
  });

  it("shows field errors and other problems", async () => {
    withSettings();
    server.use(
      fail("patch", "/api/v1/admin/settings/emails", {
        status: 422,
        errors: [{ field: "signature", code: "too_long", message: "Keep it under 500" }],
      }),
    );
    render(<EmailSettings />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Save email texts" }));
    expect(await screen.findByText("Keep it under 500")).toBeInTheDocument();
    expect(screen.getByLabelText("Signature")).toHaveAttribute("aria-invalid", "true");

    server.use(fail("patch", "/api/v1/admin/settings/emails", { status: 500, title: "Mail down" }));
    await user.click(screen.getByRole("button", { name: "Save email texts" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Mail down");
    expect(screen.queryByText("Keep it under 500")).not.toBeInTheDocument();
  });

  it("shows a load error", async () => {
    server.use(fail("get", "/api/v1/admin/settings", { status: 500, title: "Settings down" }));
    render(<EmailSettings />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Settings down");
  });
});

describe("PaymentProviders", () => {
  it("shows each provider's status without exposing keys", async () => {
    withSettings(
      settings({
        payment_providers: [
          {
            name: "stripe",
            configured: true,
            webhook_configured: true,
            mode: "live",
            currencies: ["USD", "EUR"],
            default: false,
          },
          {
            name: "paystack",
            configured: true,
            webhook_configured: false,
            mode: "test",
            currencies: [],
            default: true,
          },
          {
            name: "mollie",
            configured: false,
            webhook_configured: false,
            mode: null,
            currencies: [],
            default: false,
          },
        ],
      }),
    );
    render(<PaymentProviders />);
    expect(screen.getByLabelText("Loading providers")).toHaveAttribute("aria-busy", "true");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Keys live in the server environment",
    );

    const stripe = section("Stripe");
    expect(stripe.getAllByText("Configured")).toHaveLength(2);
    expect(stripe.getByText("Live")).toBeInTheDocument();
    expect(stripe.getByText("USD, EUR")).toBeInTheDocument();

    const paystack = section("Paystack Default");
    expect(paystack.getByText("Not configured")).toBeInTheDocument();
    expect(paystack.getByText("Test — no real money moves")).toBeInTheDocument();
    expect(paystack.getByText("All others (default)")).toBeInTheDocument();

    const other = section("mollie");
    expect(other.getAllByText("Not configured")).toHaveLength(2);
    expect(other.getByText("—")).toBeInTheDocument();
    expect(other.getByText("None routed")).toBeInTheDocument();
  });

  it("shows a load error and retries", async () => {
    server.use(fail("get", "/api/v1/admin/settings", { status: 500, title: "Settings down" }));
    render(<PaymentProviders />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Settings down");
    withSettings();
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Stripe Default" })).toBeInTheDocument();
  });
});
