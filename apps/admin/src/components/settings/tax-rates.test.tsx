import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import { TaxRates, fractionToPercent, percentToFraction } from "@/components/settings/tax-rates";
import { taxRate } from "@/test/fixtures/core";
import { fail, ok, on, server } from "@/test/server";

// The Toaster needs a real matchMedia; assert on the toast calls instead.
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

function renderPage() {
  toast.success.mockClear();
  toast.error.mockClear();
  return render(<TaxRates />);
}

async function toasted(kind: "success" | "error", message: string) {
  await waitFor(() => {
    expect(toast[kind]).toHaveBeenCalledWith(message, expect.anything());
  });
}

describe("fractionToPercent / percentToFraction", () => {
  it("shows a stored fraction as a percent", () => {
    expect(fractionToPercent("0.0725")).toBe("7.25");
    expect(fractionToPercent("0.2")).toBe("20");
    expect(fractionToPercent("abc")).toBe("abc");
  });

  it.each([
    ["7.25", "0.0725"],
    [" 20% ", "0.2000"],
    ["0", "0.0000"],
    ["100", "1.0000"],
    ["101", null],
    ["7.255", null],
    ["-1", null],
    ["seven", null],
  ])("parses %j as %j", (input, expected) => {
    expect(percentToFraction(input)).toBe(expected);
  });
});

describe("TaxRates", () => {
  it("shows a loading state, then the rates", async () => {
    server.use(
      ok("get", "/api/v1/admin/tax-rates", [
        taxRate(),
        taxRate({
          id: "t2",
          name: "VAT",
          country_code: "GB",
          region: null,
          postal_prefix: "SW",
          rate: "0.2",
          is_inclusive: true,
          priority: 1,
          is_active: false,
        }),
      ]),
    );
    renderPage();
    expect(screen.getByLabelText("Loading tax rates")).toHaveAttribute("aria-busy", "true");
    const table = await screen.findByRole("table", { name: "Tax rates" });
    const rows = within(table).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("California sales taxUS · CA7.25%Added at checkout0");
    expect(rows[2]).toHaveTextContent("VATGB · postcodes SW…20%Included in price1");
    expect(screen.getByRole("checkbox", { name: "VAT active" })).not.toBeChecked();
  });

  it("explains an empty list", async () => {
    server.use(ok("get", "/api/v1/admin/tax-rates", []));
    renderPage();
    expect(await screen.findByText("No tax rates yet")).toBeInTheDocument();
  });

  it("shows a load error and retries", async () => {
    server.use(fail("get", "/api/v1/admin/tax-rates", { status: 500, title: "Tax is down" }));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("Tax is down");
    server.use(ok("get", "/api/v1/admin/tax-rates", [taxRate()]));
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table", { name: "Tax rates" })).toBeInTheDocument();
  });

  it("switches a rate off and confirms it", async () => {
    let sent: unknown;
    server.use(
      ok("get", "/api/v1/admin/tax-rates", [taxRate()]),
      on("patch", "/api/v1/admin/tax-rates/{tax_id}", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(taxRate({ is_active: false }));
      }),
    );
    renderPage();
    const box = await screen.findByRole("checkbox", { name: "California sales tax active" });
    await userEvent.setup().click(box);
    await toasted("success", "California sales tax switched off");
    expect(box).not.toBeChecked();
    expect(sent).toEqual({ is_active: false });
  });

  it("switches a rate on", async () => {
    server.use(
      ok("get", "/api/v1/admin/tax-rates", [taxRate({ is_active: false })]),
      ok("patch", "/api/v1/admin/tax-rates/{tax_id}", taxRate({ is_active: true })),
    );
    renderPage();
    await userEvent
      .setup()
      .click(await screen.findByRole("checkbox", { name: "California sales tax active" }));
    await toasted("success", "California sales tax switched on");
  });

  it("rolls back a toggle the API refuses", async () => {
    server.use(
      ok("get", "/api/v1/admin/tax-rates", [taxRate()]),
      fail("patch", "/api/v1/admin/tax-rates/{tax_id}", {
        status: 403,
        title: "Forbidden",
        detail: "Your role cannot change tax.",
      }),
    );
    renderPage();
    const box = await screen.findByRole("checkbox", { name: "California sales tax active" });
    await userEvent.setup().click(box);
    await toasted("error", "Your role cannot change tax.");
    expect(box).toBeChecked();
  });

  it("adds a rate", async () => {
    let sent: unknown;
    server.use(
      ok("get", "/api/v1/admin/tax-rates", []),
      on("post", "/api/v1/admin/tax-rates", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(taxRate({ id: "new", name: "NY tax", region: "NY" }), {
          status: 201,
        });
      }),
    );
    renderPage();
    await screen.findByText("No tax rates yet");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add tax rate" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a tax rate" });
    const form = within(dialog);
    await user.type(form.getByLabelText("Name"), " NY tax ");
    await user.type(form.getByLabelText("Country"), "us");
    expect(form.getByLabelText("Country")).toHaveValue("US");
    await user.type(form.getByLabelText("Region (optional)"), "NY");
    await user.type(form.getByLabelText("Postal prefix (optional)"), "10");
    await user.type(form.getByLabelText("Rate (%)"), "8.875");
    await user.click(form.getByRole("button", { name: "Add tax rate" }));
    expect(
      await form.findByText("Enter a percent from 0 to 100, such as 7.25."),
    ).toBeInTheDocument();
    expect(sent).toBeUndefined();

    await user.clear(form.getByLabelText("Rate (%)"));
    await user.type(form.getByLabelText("Rate (%)"), "8.88");
    await user.click(form.getByLabelText("Prices already include this tax"));
    await user.click(form.getByRole("checkbox", { name: "Active" }));
    await user.click(form.getByRole("button", { name: "Add tax rate" }));

    await toasted("success", "NY tax added");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("table", { name: "Tax rates" })).toHaveTextContent("NY tax");
    expect(sent).toEqual({
      name: "NY tax",
      country_code: "US",
      region: "NY",
      postal_prefix: "10",
      rate: "0.0888",
      is_inclusive: true,
      priority: 0,
      is_active: false,
    });
  });

  it("rejects a priority that is not a whole number", async () => {
    server.use(ok("get", "/api/v1/admin/tax-rates", []));
    renderPage();
    await screen.findByText("No tax rates yet");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add tax rate" }));
    const form = within(await screen.findByRole("dialog"));
    await user.type(form.getByLabelText("Rate (%)"), "5");
    await user.clear(form.getByLabelText("Priority"));
    await user.type(form.getByLabelText("Priority"), "1.5");
    await user.click(form.getByRole("button", { name: "Add tax rate" }));
    expect(await form.findByText("A whole number, such as 0.")).toBeInTheDocument();
  });

  it("edits a rate, keeping its country fixed", async () => {
    let sent: unknown;
    server.use(
      ok("get", "/api/v1/admin/tax-rates", [taxRate()]),
      on("patch", "/api/v1/admin/tax-rates/{tax_id}", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(taxRate({ name: "CA tax", priority: 2 }));
      }),
    );
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit California sales tax" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit California sales tax" });
    const form = within(dialog);
    expect(form.getByLabelText("Country")).toBeDisabled();
    expect(form.getByLabelText("Country")).toHaveAccessibleDescription("Fixed once created.");
    expect(form.getByLabelText("Rate (%)")).toHaveValue("7.25");
    await user.clear(form.getByLabelText("Name"));
    await user.type(form.getByLabelText("Name"), "CA tax");
    await user.clear(form.getByLabelText("Region (optional)"));
    await user.clear(form.getByLabelText("Priority"));
    await user.type(form.getByLabelText("Priority"), "2");
    await user.click(form.getByRole("button", { name: "Save tax rate" }));

    await toasted("success", "CA tax saved");
    expect(sent).toEqual({
      name: "CA tax",
      region: null,
      postal_prefix: null,
      rate: "0.0725",
      is_inclusive: false,
      priority: 2,
      is_active: true,
    });
    expect(screen.getByRole("table", { name: "Tax rates" })).toHaveTextContent("CA tax");
  });

  it("shows API field errors in the dialog", async () => {
    server.use(
      ok("get", "/api/v1/admin/tax-rates", []),
      fail("post", "/api/v1/admin/tax-rates", {
        status: 422,
        slug: "validation-failed",
        title: "Invalid",
        errors: [{ field: "country_code", code: "invalid", message: "Unknown country" }],
      }),
    );
    renderPage();
    await screen.findByText("No tax rates yet");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add tax rate" }));
    const form = within(await screen.findByRole("dialog"));
    await user.type(form.getByLabelText("Country"), "zz");
    await user.type(form.getByLabelText("Rate (%)"), "5");
    await user.click(form.getByRole("button", { name: "Add tax rate" }));
    expect(await form.findByText("Unknown country")).toBeInTheDocument();
    expect(form.getByLabelText("Country")).toHaveAttribute("aria-invalid", "true");
  });

  it("closes the dialog on Cancel", async () => {
    server.use(ok("get", "/api/v1/admin/tax-rates", []));
    renderPage();
    await screen.findByText("No tax rates yet");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add tax rate" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }),
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});
