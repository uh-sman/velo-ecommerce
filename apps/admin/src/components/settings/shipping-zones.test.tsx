import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import { ShippingZones } from "@/components/settings/shipping-zones";
import { settings, shippingRate, shippingZone } from "@/test/fixtures/core";
import { fail, ok, on, server } from "@/test/server";

// The Toaster needs a real matchMedia; assert on the toast calls instead.
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

async function toasted(kind: "success" | "error", message: string) {
  await waitFor(() => {
    expect(toast[kind]).toHaveBeenCalledWith(message, expect.anything());
  });
}

function renderPage(zones = [shippingZone()], currency: string | null = "USD") {
  toast.success.mockClear();
  toast.error.mockClear();
  server.use(
    ok("get", "/api/v1/admin/shipping-zones", zones),
    currency === null
      ? fail("get", "/api/v1/admin/settings", { status: 500 })
      : ok("get", "/api/v1/admin/settings", settings({ store: { currency } })),
  );
  return render(<ShippingZones />);
}

function rateRow(name: string) {
  const cell = screen.getByText(name, { selector: "span.block" });
  const row = cell.closest("tr");
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

describe("ShippingZones", () => {
  it("shows a loading state, then each zone and its rates in plain words", async () => {
    renderPage([
      shippingZone({
        regions: ["CA", "NY"],
        country_codes: ["US", "CA"],
        rates: [
          shippingRate({ id: "r1", name: "Free", price_amount: 0, description: "Tracked" }),
          shippingRate({
            id: "r2",
            name: "Bands",
            min_subtotal_amount: 5000,
            max_subtotal_amount: 10000,
            min_weight_grams: 500,
            max_weight_grams: 2000,
            est_days_min: 2,
            est_days_max: 5,
          }),
          shippingRate({
            id: "r3",
            name: "Floors",
            min_subtotal_amount: 2500,
            min_weight_grams: 1500,
            est_days_min: 3,
            est_days_max: 3,
          }),
          shippingRate({
            id: "r4",
            name: "Caps",
            max_subtotal_amount: 1000,
            max_weight_grams: 750,
            est_days_max: 7,
          }),
          shippingRate({
            id: "r5",
            name: "Odd",
            currency: "ZZZZ",
            price_amount: 1234,
            est_days_min: 4,
          }),
        ],
      }),
      shippingZone({ id: "z2", name: "Overseas", is_active: false, rates: [] }),
    ]);
    expect(screen.getByLabelText("Loading shipping zones")).toHaveAttribute("aria-busy", "true");
    expect(await screen.findByRole("heading", { name: "Domestic" })).toBeInTheDocument();
    expect(screen.getByText("US, CA · regions: CA, NY")).toBeInTheDocument();

    expect(rateRow("Free")).toHaveTextContent("FreeTrackedFreeAny order—");
    expect(rateRow("Bands")).toHaveTextContent("$5.00Orders $50.00–$100.00, 500 g–2 kg2–5 days");
    expect(rateRow("Floors")).toHaveTextContent("Orders $25.00 and up, from 1.5 kg3 days");
    expect(rateRow("Caps")).toHaveTextContent("Orders up to $10.00, up to 750 gUp to 7 days");
    expect(rateRow("Odd")).toHaveTextContent("12.34 ZZZZAny order4+ days");

    expect(screen.getByRole("heading", { name: "Overseas Inactive" })).toBeInTheDocument();
    expect(
      screen.getByText("No rates yet — customers in this zone cannot choose a shipping method."),
    ).toBeInTheDocument();
  });

  it("explains an empty list", async () => {
    renderPage([]);
    expect(await screen.findByText("No shipping zones yet")).toBeInTheDocument();
  });

  it("shows a load error and retries", async () => {
    server.use(
      fail("get", "/api/v1/admin/shipping-zones", { status: 500, detail: "Zones unavailable" }),
      ok("get", "/api/v1/admin/settings", settings()),
    );
    render(<ShippingZones />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Zones unavailable");
    server.use(ok("get", "/api/v1/admin/shipping-zones", []));
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No shipping zones yet")).toBeInTheDocument();
  });

  it("hides a zone from checkout", async () => {
    let sent: unknown;
    renderPage();
    server.use(
      on("patch", "/api/v1/admin/shipping-zones/{zone_id}", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(shippingZone({ is_active: false }));
      }),
    );
    await screen.findByRole("heading", { name: "Domestic" });
    await userEvent.setup().click(screen.getByRole("checkbox", { name: "Active" }));
    await toasted("success", "Domestic is hidden from checkout");
    expect(sent).toEqual({ is_active: false });
    expect(screen.getByRole("heading", { name: "Domestic Inactive" })).toBeInTheDocument();
  });

  it("offers a zone at checkout", async () => {
    renderPage([shippingZone({ is_active: false })]);
    server.use(ok("patch", "/api/v1/admin/shipping-zones/{zone_id}", shippingZone()));
    await userEvent.setup().click(await screen.findByRole("checkbox", { name: "Active" }));
    await toasted("success", "Domestic is offered at checkout");
  });

  it("rolls back a zone toggle the API refuses", async () => {
    renderPage();
    server.use(
      fail("patch", "/api/v1/admin/shipping-zones/{zone_id}", {
        status: 403,
        title: "Forbidden",
      }),
    );
    const box = await screen.findByRole("checkbox", { name: "Active" });
    await userEvent.setup().click(box);
    await toasted("error", "Forbidden");
    expect(box).toBeChecked();
  });

  it("switches a rate off and on, rolling back a refusal", async () => {
    renderPage([shippingZone({ rates: [shippingRate()] })]);
    server.use(
      ok("patch", "/api/v1/admin/shipping-rates/{rate_id}", shippingRate({ is_active: false })),
    );
    const user = userEvent.setup();
    const box = await screen.findByRole("checkbox", { name: "Standard active" });
    await user.click(box);
    await toasted("success", "Standard switched off");
    expect(box).not.toBeChecked();

    server.use(
      ok("patch", "/api/v1/admin/shipping-rates/{rate_id}", shippingRate({ is_active: true })),
    );
    await user.click(box);
    await toasted("success", "Standard switched on");
    expect(box).toBeChecked();

    server.use(
      fail("patch", "/api/v1/admin/shipping-rates/{rate_id}", {
        status: 409,
        title: "Conflict",
        detail: "Rate is locked.",
      }),
    );
    await user.click(box);
    await toasted("error", "Rate is locked.");
    expect(box).toBeChecked();
  });

  it("adds a zone, requiring at least one country", async () => {
    let sent: unknown;
    renderPage([]);
    server.use(
      on("post", "/api/v1/admin/shipping-zones", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(
          shippingZone({ id: "z9", name: "North America", country_codes: ["US", "CA"] }),
          { status: 201 },
        );
      }),
    );
    await screen.findByText("No shipping zones yet");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add zone" }));
    const form = within(await screen.findByRole("dialog", { name: "Add a shipping zone" }));
    await user.type(form.getByLabelText("Name"), "  North America ");
    await user.click(form.getByRole("button", { name: "Add zone" }));
    expect(await form.findByText("Add at least one country code, such as US.")).toBeInTheDocument();
    expect(sent).toBeUndefined();

    await user.type(form.getByLabelText("Countries"), "us,  ca");
    await user.click(form.getByRole("button", { name: "Add zone" }));
    await toasted("success", "North America added");
    expect(sent).toEqual({
      name: "North America",
      country_codes: ["US", "CA"],
      regions: null,
      is_active: true,
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("heading", { name: "North America" })).toBeInTheDocument();
  });

  it("edits a zone and puts list errors on the list field", async () => {
    const sent: unknown[] = [];
    renderPage([shippingZone({ regions: ["CA"] })]);
    server.use(
      on("patch", "/api/v1/admin/shipping-zones/{zone_id}", async ({ request }) => {
        sent.push(await request.json());
        return sent.length === 1
          ? HttpResponse.json(
              {
                type: "https://velo.dev/errors/validation-failed",
                title: "Invalid",
                status: 422,
                errors: [
                  { field: "country_codes.1", code: "invalid", message: "Unknown country XX" },
                  { field: "country_codes.2", code: "invalid", message: "Unknown country YY" },
                ],
              },
              { status: 422 },
            )
          : HttpResponse.json(shippingZone({ name: "Home", regions: ["CA", "NY"] }));
      }),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit zone" }));
    const form = within(await screen.findByRole("dialog", { name: "Edit Domestic" }));
    expect(form.getByLabelText("Countries")).toHaveValue("US");
    expect(form.getByLabelText("Regions (optional)")).toHaveValue("CA");
    await user.type(form.getByLabelText("Countries"), ", xx, yy");
    await user.click(form.getByRole("button", { name: "Save zone" }));
    expect(await form.findByText("Unknown country XX")).toBeInTheDocument();
    expect(form.queryByText("Unknown country YY")).not.toBeInTheDocument();
    expect(form.getByLabelText("Countries")).toHaveAttribute("aria-invalid", "true");

    await user.clear(form.getByLabelText("Name"));
    await user.type(form.getByLabelText("Name"), "Home");
    await user.clear(form.getByLabelText("Countries"));
    await user.type(form.getByLabelText("Countries"), "US");
    await user.type(form.getByLabelText("Regions (optional)"), ", NY,");
    await user.click(form.getByRole("checkbox", { name: "Active" }));
    await user.click(form.getByRole("button", { name: "Save zone" }));
    await toasted("success", "Home saved");
    expect(sent[1]).toEqual({
      name: "Home",
      country_codes: ["US"],
      regions: ["CA", "NY"],
      is_active: false,
    });
    expect(screen.getByText("US · regions: CA, NY")).toBeInTheDocument();
  });

  it("adds a rate in the store currency", async () => {
    let sent: unknown;
    renderPage([shippingZone({ rates: [shippingRate()] })], "EUR");
    server.use(
      on("post", "/api/v1/admin/shipping-zones/{zone_id}/rates", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(
          shippingRate({ id: "r2", name: "Express", currency: "EUR", price_amount: 1500 }),
          { status: 201 },
        );
      }),
    );
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Domestic" });
    // Wait for the settings call too, so the dialog sees the store currency.
    await waitFor(() => {
      expect(screen.queryByLabelText("Loading shipping zones")).not.toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Add rate" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a rate to Domestic" });
    await waitFor(() => {
      expect(dialog).toHaveAccessibleDescription(
        "Prices in EUR. Leave a condition blank to have no limit.",
      );
    });
    const form = within(dialog);
    await user.type(form.getByLabelText("Name"), "Express");
    await user.click(form.getByRole("button", { name: "Add rate" }));
    expect(await form.findByText("Enter a price; 0 is free.")).toBeInTheDocument();
    expect(form.getByLabelText("Price")).toHaveAttribute("aria-invalid", "true");

    await user.type(form.getByLabelText("Price"), "15");
    await user.type(form.getByLabelText("Description (optional)"), "Next day");
    const subtotal = within(form.getByRole("group", { name: "Order subtotal" }));
    await user.type(subtotal.getByLabelText("From (optional)"), "20.50");
    const weight = within(form.getByRole("group", { name: "Parcel weight (grams)" }));
    await user.type(weight.getByLabelText("Up to (optional)"), "5000");
    const delivery = within(form.getByRole("group", { name: "Delivery estimate (days)" }));
    await user.type(delivery.getByLabelText("Fastest (optional)"), "1");
    await user.type(delivery.getByLabelText("Slowest (optional)"), "2");
    expect(delivery.getByLabelText("Order shown")).toHaveValue(1);
    await user.click(form.getByRole("button", { name: "Add rate" }));

    await toasted("success", "Express added");
    expect(sent).toEqual({
      name: "Express",
      description: "Next day",
      price_amount: 1500,
      min_subtotal_amount: 2050,
      max_subtotal_amount: null,
      min_weight_grams: null,
      max_weight_grams: 5000,
      est_days_min: 1,
      est_days_max: 2,
      is_active: true,
      position: 1,
      currency: "EUR",
    });
    expect(screen.getByText("Express", { selector: "span.block" })).toBeInTheDocument();
  });

  it("falls back to USD when the store settings cannot be read", async () => {
    renderPage([shippingZone()], null);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add rate" }));
    expect(await screen.findByRole("dialog")).toHaveAccessibleDescription(
      "Prices in USD. Leave a condition blank to have no limit.",
    );
  });

  it("edits a rate, showing an API problem at the top of the dialog", async () => {
    const sent: unknown[] = [];
    const rate = shippingRate({
      description: "Tracked",
      min_subtotal_amount: 1000,
      max_weight_grams: 2000,
      est_days_min: 2,
      est_days_max: 4,
      position: 3,
    });
    renderPage([shippingZone({ rates: [rate] })]);
    server.use(
      on("patch", "/api/v1/admin/shipping-rates/{rate_id}", async ({ request }) => {
        sent.push(await request.json());
        return sent.length === 1
          ? HttpResponse.json(
              {
                type: "https://velo.dev/errors/conflict",
                title: "Rate changed elsewhere",
                status: 409,
              },
              { status: 409 },
            )
          : HttpResponse.json({ ...rate, name: "Standard+", price_amount: 650 });
      }),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit Standard" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Standard" });
    const form = within(dialog);
    expect(form.getByLabelText("Price")).toHaveValue("5.00");
    expect(form.getByLabelText("Description (optional)")).toHaveValue("Tracked");
    await user.clear(form.getByLabelText("Name"));
    await user.type(form.getByLabelText("Name"), "Standard+");
    await user.clear(form.getByLabelText("Price"));
    await user.type(form.getByLabelText("Price"), "6.50");
    const delivery = within(form.getByRole("group", { name: "Delivery estimate (days)" }));
    await user.clear(delivery.getByLabelText("Order shown"));
    await user.type(delivery.getByLabelText("Order shown"), "1.5");
    await user.clear(form.getByLabelText("Description (optional)"));
    await user.click(form.getByRole("checkbox", { name: "Active" }));
    await user.click(form.getByRole("button", { name: "Save rate" }));
    expect(await form.findByRole("alert")).toHaveTextContent("Rate changed elsewhere");

    await user.click(form.getByRole("button", { name: "Save rate" }));
    await toasted("success", "Standard+ saved");
    expect(sent[1]).toEqual({
      name: "Standard+",
      description: null,
      price_amount: 650,
      min_subtotal_amount: 1000,
      max_subtotal_amount: null,
      min_weight_grams: null,
      max_weight_grams: 2000,
      est_days_min: 2,
      est_days_max: 4,
      is_active: false,
      position: 0,
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(rateRow("Standard+")).toHaveTextContent("$6.50");
  });

  it("closes a dialog on Cancel", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit zone" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }),
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Add rate" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }),
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("targets the zone it was opened for", async () => {
    renderPage([shippingZone(), shippingZone({ id: "z2", name: "EU", country_codes: ["DE"] })]);
    let path = "";
    server.use(
      on("post", "/api/v1/admin/shipping-zones/{zone_id}/rates", ({ request }) => {
        path = new URL(request.url).pathname;
        return HttpResponse.json(shippingRate({ id: "r9", zone_id: "z2", name: "EU std" }), {
          status: 201,
        });
      }),
    );
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "EU" });
    const addButtons = screen.getAllByRole("button", { name: "Add rate" });
    await user.click(addButtons[1] as HTMLElement);
    const form = within(await screen.findByRole("dialog", { name: "Add a rate to EU" }));
    await user.type(form.getByLabelText("Price"), "0");
    await user.click(form.getByRole("button", { name: "Add rate" }));
    await toasted("success", "EU std added");
    expect(path).toBe("/api/v1/admin/shipping-zones/z2/rates");
  });
});
