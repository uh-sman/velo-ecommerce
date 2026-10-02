import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { collection, discountView, productView } from "@/test/fixtures/people";
import { router } from "@/test/navigation";
import { fail, ok, on, server } from "@/test/server";

import { DiscountBuilder, DiscountEditor } from "./discount-builder";

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", () => ({ toast, Toaster: () => null }));

const LIST = "/api/v1/admin/discounts";
const ONE = "/api/v1/admin/discounts/{discount_id}";
const COLLECTIONS = "/api/v1/admin/collections";
const PRODUCT = "/api/v1/admin/products/{product_id}";

beforeEach(() => {
  vi.clearAllMocks();
});

function summary(): HTMLElement {
  return within(screen.getByRole("complementary", { name: "Summary and test" })).getByText(
    /^“.*”$/,
  );
}

function field(name: string | RegExp): HTMLElement {
  return screen.getByRole("textbox", { name });
}

/** Capture what the builder POSTs, answering with a created discount. */
function captureCreate() {
  const sent: unknown[] = [];
  server.use(
    on("post", LIST, async ({ request }) => {
      sent.push(await request.json());
      return HttpResponse.json(discountView({ id: "d-new" }), { status: 201 });
    }),
  );
  return sent;
}

describe("DiscountBuilder — a new discount", { timeout: 20_000 }, () => {
  it("reads the rule back as a sentence while it is typed", async () => {
    const user = userEvent.setup();
    render(<DiscountBuilder />);
    expect(screen.getByRole("heading", { name: "New discount" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Active" })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^Starts/)).toHaveAccessibleDescription(
      "Blank: as soon as it is saved.",
    );
    expect(summary()).toHaveTextContent(
      "“…% off everything, applied automatically, no code needed, does not combine with other discounts.”",
    );
    expect(
      screen.getByText("Blank: an automatic discount, applied to every cart that qualifies."),
    ).toBeInTheDocument();

    await user.type(field("Percent off"), "20");
    await user.type(field(/^Code/), "spring20");
    expect(field(/^Code/)).toHaveValue("SPRING20");
    expect(
      screen.getByText("Customers enter this code at checkout. Letters, numbers, - and _."),
    ).toBeInTheDocument();
    expect(summary()).toHaveTextContent(/^“20% off everything, with code SPRING20,/);
    expect(
      screen.getByText("Example: an order of $100.00 pays $80.00 before shipping and tax."),
    ).toBeInTheDocument();
  });

  it("generates a readable code", async () => {
    const user = userEvent.setup();
    render(<DiscountBuilder />);
    await user.click(screen.getByRole("button", { name: "Generate" }));
    expect((field(/^Code/) as HTMLInputElement).value).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  });

  it("shows the value fields each type needs", async () => {
    const user = userEvent.setup();
    render(<DiscountBuilder />);

    await user.click(screen.getByRole("radio", { name: /^Fixed amount/ }));
    await user.type(field("Amount off"), "10");
    const currency = field("Currency");
    await user.clear(currency);
    await user.type(currency, "eur");
    expect(currency).toHaveValue("EUR");
    expect(summary()).toHaveTextContent(/^“€10\.00 off everything/);
    expect(field(/^Minimum order subtotal/)).toHaveAccessibleDescription(
      "In EUR, before shipping and tax. Blank: no minimum.",
    );
    await user.clear(currency);
    expect(field(/^Minimum order subtotal/)).toHaveAccessibleDescription(
      "In the store currency, before shipping and tax. Blank: no minimum.",
    );

    await user.click(screen.getByRole("radio", { name: /^Free shipping/ }));
    expect(
      screen.getByText("No value needed: the shipping charge is waived when the rule applies."),
    ).toBeInTheDocument();
    expect(summary()).toHaveTextContent(/^“Free shipping on the whole order,/);

    await user.click(screen.getByRole("radio", { name: /^Buy X get Y/ }));
    await user.type(screen.getByRole("spinbutton", { name: "Customer buys" }), "2");
    await user.type(screen.getByRole("spinbutton", { name: "And gets" }), "1");
    // The value is shared between types, so the fixed amount typed earlier is still there.
    const reward = field("Percent off what they get");
    expect(reward).toHaveValue("10");
    await user.clear(reward);
    await user.type(reward, "100");
    expect(summary()).toHaveTextContent(/^“Buy 2, get 1 free \(the cheapest items/);
  });

  it("scopes to products or collections, and forgets targets when the scope changes", async () => {
    server.use(ok("get", COLLECTIONS, [collection()]));
    const user = userEvent.setup();
    render(<DiscountBuilder />);

    await user.click(screen.getByRole("radio", { name: "Specific collections" }));
    await user.click(await screen.findByRole("button", { name: "Add Summer" }));
    expect(summary()).toHaveTextContent(/everything in Summer/);
    // Clicking the current scope again keeps what was chosen.
    await user.click(screen.getByRole("radio", { name: "Specific collections" }));
    expect(screen.getByRole("list", { name: "Chosen collections" })).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Specific products" }));
    expect(screen.getByText(/No products chosen yet/)).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Add products" })).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Entire order" }));
    expect(screen.queryByRole("searchbox", { name: "Add products" })).not.toBeInTheDocument();
  });

  it("activates the discount with every field the operator set", async () => {
    const sent = captureCreate();
    const user = userEvent.setup();
    render(<DiscountBuilder />);

    await user.type(field("Title"), "  Spring sale ");
    await user.type(field(/^Code/), "spring20");
    await user.type(field("Percent off"), "20");
    await user.type(field(/^Minimum order subtotal/), "50");
    await user.selectOptions(screen.getByRole("combobox", { name: "Who can use it" }), "returning");
    await user.click(screen.getByRole("checkbox", { name: "First order only" }));
    await user.type(screen.getByRole("spinbutton", { name: /^Total uses/ }), "100");
    await user.type(screen.getByRole("spinbutton", { name: /^Uses per customer/ }), "1");
    await user.click(screen.getByRole("checkbox", { name: "Combines with other discounts" }));
    fireEvent.change(screen.getByLabelText(/^Starts/), { target: { value: "2026-11-01T10:00" } });
    fireEvent.change(screen.getByLabelText(/^Ends/), { target: { value: "2026-11-30T18:00" } });

    expect(summary()).toHaveTextContent(
      /for returning customers, for a customer's first order, on orders of \$50\.00 or more, limited to 100 uses, once per customer, combines with other discounts/,
    );
    await user.click(screen.getByRole("button", { name: "Activate" }));

    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith("/discounts/d-new");
    });
    expect(sent).toEqual([
      {
        code: "SPRING20",
        title: "Spring sale",
        type: "percentage",
        value: "20",
        currency: null,
        min_subtotal_amount: 5000,
        applies_to: "all",
        target_ids: null,
        first_order_only: true,
        max_redemptions: 100,
        max_per_customer: 1,
        is_stackable: true,
        starts_at: new Date("2026-11-01T10:00").toISOString(),
        ends_at: new Date("2026-11-30T18:00").toISOString(),
        is_active: true,
        buy_quantity: null,
        get_quantity: null,
        customer_segment: "returning",
      },
    ]);
    expect(toast.success).toHaveBeenCalledWith("Discount created and active", expect.anything());
  });

  it("saves a draft switched off", async () => {
    const sent = captureCreate();
    const user = userEvent.setup();
    render(<DiscountBuilder />);
    await user.type(field("Title"), "Later");
    await user.click(screen.getByRole("button", { name: "Save as draft" }));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith("/discounts/d-new");
    });
    expect(sent[0]).toMatchObject({ title: "Later", is_active: false });
    expect(toast.success).toHaveBeenCalledWith("Discount saved as a draft", expect.anything());
  });

  it("puts the API's field errors on their fields, and clears one when it is edited", async () => {
    const errors = [
      ["title", "Give it a title."],
      ["code", "That code is taken."],
      ["type", "Pick a type."],
      ["value", "Between 0.01 and 100."],
      ["applies_to", "Pick a scope."],
      ["min_subtotal_amount", "Must be positive."],
      ["customer_segment", "Unknown segment."],
      ["max_redemptions", "At least 1."],
      ["max_per_customer", "At least 1, too."],
      ["starts_at", "Start before the end."],
      ["ends_at", "End after the start."],
    ] as const;
    server.use(
      fail("post", LIST, {
        status: 422,
        title: "Check the discount",
        errors: errors.map(([fieldName, message]) => ({ field: fieldName, code: "x", message })),
      }),
    );
    const user = userEvent.setup();
    render(<DiscountBuilder />);
    await user.click(screen.getByRole("button", { name: "Activate" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Check the discount");
    expect(field("Title")).toHaveAccessibleDescription(/Give it a title\./);
    expect(field(/^Code/)).toHaveAccessibleDescription("That code is taken.");
    expect(screen.getByRole("group", { name: "Type" })).toHaveAccessibleDescription("Pick a type.");
    expect(field("Percent off")).toHaveAccessibleDescription(/Between 0\.01 and 100\./);
    expect(screen.getByRole("group", { name: "Which items" })).toHaveAccessibleDescription(
      "Pick a scope.",
    );
    expect(field(/^Minimum order subtotal/)).toHaveAccessibleDescription(/Must be positive\./);
    expect(screen.getByRole("combobox", { name: "Who can use it" })).toHaveAccessibleDescription(
      "Unknown segment.",
    );
    expect(screen.getByRole("spinbutton", { name: /^Total uses/ })).toHaveAccessibleDescription(
      /At least 1\./,
    );
    expect(
      screen.getByRole("spinbutton", { name: /^Uses per customer/ }),
    ).toHaveAccessibleDescription(/At least 1, too\./);
    expect(screen.getByLabelText(/^Starts/)).toHaveAccessibleDescription(/Start before the end\./);
    expect(screen.getByLabelText(/^Ends/)).toHaveAccessibleDescription(/End after the start\./);
    expect(router.push).not.toHaveBeenCalled();

    await user.type(field("Title"), "Spring");
    expect(field("Title")).not.toHaveAttribute("aria-invalid");
    expect(field(/^Code/)).toHaveAttribute("aria-invalid", "true");
    // A field without an error to clear leaves the others alone.
    await user.click(screen.getByRole("checkbox", { name: "First order only" }));
    expect(field(/^Code/)).toHaveAttribute("aria-invalid", "true");
  });

  it("puts errors on the fields of the other value types too", async () => {
    server.use(
      fail("post", LIST, {
        status: 422,
        title: "Invalid",
        errors: [
          { field: "currency", code: "x", message: "Use the store currency." },
          { field: "buy_quantity", code: "x", message: "Buy at least one." },
          { field: "get_quantity", code: "x", message: "Get at least one." },
          { field: "target_ids", code: "x", message: "Choose a product." },
        ],
      }),
    );
    const user = userEvent.setup();
    render(<DiscountBuilder />);
    await user.click(screen.getByRole("radio", { name: /^Fixed amount/ }));
    await user.click(screen.getByRole("radio", { name: "Specific products" }));
    await user.click(screen.getByRole("button", { name: "Activate" }));

    expect(await screen.findByText("Use the store currency.")).toBeInTheDocument();
    expect(field("Currency")).toHaveAccessibleDescription(/Use the store currency\./);
    expect(screen.getByText("Choose a product.")).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /^Buy X get Y/ }));
    expect(screen.getByRole("spinbutton", { name: "Customer buys" })).toHaveAccessibleDescription(
      "Buy at least one.",
    );
    expect(screen.getByRole("spinbutton", { name: "And gets" })).toHaveAccessibleDescription(
      "Get at least one.",
    );
  });
});

describe("DiscountBuilder — an existing discount", { timeout: 20_000 }, () => {
  it("shows its status, usage and the editing-only controls", () => {
    render(<DiscountBuilder view={discountView({ status: "scheduled", times_redeemed: 0 })} />);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("Spring sale");
    expect(heading).toHaveTextContent("Scheduled");
    expect(screen.getByText(/^Used 0 times · created /)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Active" })).toBeChecked();
    expect(screen.getByLabelText(/^Starts/)).toHaveAccessibleDescription(
      "Blank: keep the current start.",
    );
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Activate" })).not.toBeInTheDocument();
    expect(screen.queryByText("This discount has been used")).not.toBeInTheDocument();
  });

  it("does not send a save when nothing changed", async () => {
    const user = userEvent.setup();
    render(<DiscountBuilder view={discountView({ status: "scheduled" })} />);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(toast.info).toHaveBeenCalledWith("Nothing has changed.", expect.anything());
  });

  it("sends only the changed fields of a discount that is not live", async () => {
    let sent: unknown;
    server.use(
      on("patch", ONE, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(
          discountView({ title: "Spring sale 2", status: "inactive", is_active: false }),
        );
      }),
    );
    const user = userEvent.setup();
    render(<DiscountBuilder view={discountView({ status: "scheduled" })} />);
    await user.type(field("Title"), " 2");
    await user.click(screen.getByRole("checkbox", { name: "Active" }));
    expect(summary()).toHaveTextContent(/^“Switched off — 20% off everything/);
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Spring sale 2");
    });
    expect(sent).toEqual({ title: "Spring sale 2", is_active: false });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Inactive");
    expect(toast.success).toHaveBeenCalledWith("Discount saved", expect.anything());

    // The saved state is the new baseline.
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(toast.info).toHaveBeenCalledWith("Nothing has changed.", expect.anything());
  });

  it("confirms a change to a live discount, showing the rule before and after", async () => {
    let sent: unknown;
    server.use(
      on("patch", ONE, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(discountView({ value: "25.0000" }));
      }),
    );
    const user = userEvent.setup();
    render(<DiscountBuilder view={discountView()} />);
    const value = field("Percent off");
    await user.clear(value);
    await user.type(value, "25");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const dialog = await screen.findByRole("dialog", { name: "Change a live discount?" });
    expect(dialog).toHaveTextContent(/Before20% off everything, with code SPRING20/);
    expect(dialog).toHaveTextContent(/After25% off everything, with code SPRING20/);
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(sent).toEqual({ value: "25" });
    expect(field("Percent off")).toHaveValue("25");
  });

  it("keeps the confirmation open with the reason when a live change is refused", async () => {
    server.use(
      fail("patch", ONE, {
        status: 409,
        title: "Conflict",
        detail: "This discount has been used, so its terms are fixed.",
      }),
    );
    const user = userEvent.setup();
    render(<DiscountBuilder view={discountView()} />);
    await user.type(field("Percent off"), "5");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    const dialog = await screen.findByRole("dialog", { name: "Change a live discount?" });
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "This discount has been used, so its terms are fixed.",
    );

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This discount has been used, so its terms are fixed.",
    );
  });

  it("deletes an unused discount and returns to the list", async () => {
    let deleted: string | undefined;
    server.use(
      on("delete", ONE, ({ params }) => {
        deleted = String(params["discount_id"]);
        return HttpResponse.json({ outcome: "deleted" });
      }),
    );
    const user = userEvent.setup();
    render(<DiscountBuilder view={discountView()} />);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete this discount?" });
    expect(dialog).toHaveTextContent("It has never been used, so it is removed completely.");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith("/discounts");
    });
    expect(deleted).toBe("d0000000-0000-4000-8000-000000000001");
    expect(toast.success).toHaveBeenCalledWith("Discount deleted", expect.anything());
  });

  it("explains fixed terms on a used discount, and deactivates rather than deletes it", async () => {
    server.use(ok("delete", ONE, { outcome: "deactivated" }));
    const user = userEvent.setup();
    render(<DiscountBuilder view={discountView({ times_redeemed: 1 })} />);
    expect(screen.getByRole("status")).toHaveTextContent("This discount has been used");
    expect(screen.getByText(/^Used 1 time · created /)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Deactivate" }));
    const dialog = await screen.findByRole("dialog", { name: "Deactivate this discount?" });
    expect(dialog).toHaveTextContent("It has been used, so it is kept for order history");
    await user.click(within(dialog).getByRole("button", { name: "Deactivate" }));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith("/discounts");
    });
    expect(toast.success).toHaveBeenCalledWith(
      "It had been used, so it was deactivated rather than deleted",
      expect.anything(),
    );
  });

  it("shows why a delete failed", async () => {
    server.use(fail("delete", ONE, { status: 403, title: "Forbidden", detail: "Not allowed." }));
    const user = userEvent.setup();
    render(<DiscountBuilder view={discountView()} />);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Not allowed.");
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe("DiscountEditor", { timeout: 20_000 }, () => {
  it("loads the discount into the builder", async () => {
    server.use(ok("get", ONE, discountView()));
    render(<DiscountEditor id="d0000000-0000-4000-8000-000000000001" />);
    expect(screen.getByLabelText("Loading discount")).toHaveAttribute("aria-busy", "true");
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Spring sale");
    expect(field("Percent off")).toHaveValue("20");
  });

  it("names the collections a discount targets", async () => {
    server.use(
      ok(
        "get",
        ONE,
        discountView({
          applies_to: "collections",
          target_ids: ["k0000000-0000-4000-8000-000000000001", "k-gone"],
        }),
      ),
      ok("get", COLLECTIONS, [collection()]),
    );
    render(<DiscountEditor id="d1" />);
    const chosen = await screen.findByRole("list", { name: "Chosen collections" });
    expect(within(chosen).getByText("Summer")).toBeInTheDocument();
    expect(within(chosen).getByText("Unknown item")).toBeInTheDocument();
  });

  it("still opens when the collection names cannot be loaded", async () => {
    server.use(
      ok("get", ONE, discountView({ applies_to: "collections", target_ids: ["k1"] })),
      fail("get", COLLECTIONS, { status: 500, title: "Down" }),
    );
    render(<DiscountEditor id="d1" />);
    const chosen = await screen.findByRole("list", { name: "Chosen collections" });
    expect(within(chosen).getByText("Unknown item")).toBeInTheDocument();
  });

  it("names the products a discount targets, one request each", async () => {
    const asked: string[] = [];
    server.use(
      ok("get", ONE, discountView({ applies_to: "products", target_ids: ["p1", "p2"] })),
      on("get", PRODUCT, ({ params }) => {
        const id = String(params["product_id"]);
        asked.push(id);
        return id === "p1"
          ? HttpResponse.json(productView({ id: "p1", title: "Trail runner" }))
          : HttpResponse.json(
              { type: "https://velo.dev/errors/not-found", title: "Not found", status: 404 },
              { status: 404 },
            );
      }),
    );
    render(<DiscountEditor id="d1" />);
    const chosen = await screen.findByRole("list", { name: "Chosen products" });
    expect(within(chosen).getByText("Trail runner")).toBeInTheDocument();
    expect(within(chosen).getByText("Unknown item")).toBeInTheDocument();
    expect(asked.sort()).toEqual(["p1", "p2"]);
  });

  it("shows the problem when the discount cannot be loaded, and retries", async () => {
    server.use(fail("get", ONE, { status: 404, title: "Discount not found" }));
    const user = userEvent.setup();
    render(<DiscountEditor id="d1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Discount not found");
    expect(screen.getByRole("heading", { name: "Discount" })).toBeInTheDocument();
    server.use(ok("get", ONE, discountView()));
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Spring sale");
  });
});
