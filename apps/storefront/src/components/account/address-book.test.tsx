import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AddressBook } from "@/components/account/address-book";
import { anAddress } from "@/test/fixtures/account";
import { fail, ok, on, server } from "@/test/server";

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

const HOME = anAddress({ id: "home", is_default_shipping: true, is_default_billing: true });
const WORK = anAddress({
  id: "work",
  label: null,
  first_name: "Grace",
  last_name: "Hopper",
  line1: "2 Compiler Court",
  line2: "Floor 3",
  city: "Arlington",
  region: "VA",
  postal_code: "22201",
  country_code: "US",
});

function listing(...addresses: ReturnType<typeof anAddress>[]) {
  return ok("get", "/api/v1/account/addresses", addresses);
}

describe("AddressBook", () => {
  it("shows a loading state, then each address with its default badges", async () => {
    server.use(listing(HOME, WORK));
    const { container } = render(<AddressBook />);
    expect(container.querySelector("[aria-busy]")).toBeInTheDocument();
    const items = await screen.findAllByRole("listitem");
    const [home, work] = items as [HTMLElement, HTMLElement];
    expect(home).toHaveTextContent("Home");
    expect(home).toHaveTextContent("Default shipping");
    expect(home).toHaveTextContent("Default billing");
    expect(home).toHaveTextContent("1 Analytical Way, London, SW1A 1AA");
    // No label: named after the person.
    expect(within(work).getByText("Grace Hopper")).toBeInTheDocument();
    expect(work).toHaveTextContent("2 Compiler Court, Floor 3, Arlington, VA, 22201");
    expect(work).not.toHaveTextContent("Default");
  });

  it("explains an empty address book", async () => {
    server.use(listing());
    render(<AddressBook />);
    expect(await screen.findByText(/No saved addresses/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add an address" })).toBeInTheDocument();
  });

  it("offers a retry when addresses cannot load", async () => {
    server.use(fail("get", "/api/v1/account/addresses", { status: 503 }));
    const user = userEvent.setup();
    render(<AddressBook />);
    expect(await screen.findByRole("alert")).toHaveTextContent("We could not load your addresses");
    server.use(listing(HOME));
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findAllByRole("listitem")).toHaveLength(1);
  });

  it("adds an address with trimmed values, blanks as null, and reloads", async () => {
    let sent: unknown;
    let loads = 0;
    server.use(
      on("get", "/api/v1/account/addresses", () => {
        loads += 1;
        return HttpResponse.json(loads === 1 ? [] : [WORK]);
      }),
      on("post", "/api/v1/account/addresses", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(WORK, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    render(<AddressBook />);
    await user.click(await screen.findByRole("button", { name: "Add an address" }));
    const dialog = await screen.findByRole("dialog", { name: "Add an address" });
    const field = (name: string | RegExp) => within(dialog).getByRole("textbox", { name });
    expect(field("Country code")).toHaveValue("US");
    await user.type(field("First name"), " Grace ");
    await user.type(field("Last name"), "Hopper");
    await user.type(field("Address"), "2 Compiler Court");
    await user.type(field("City"), "Arlington");
    await user.type(field(/State \/ region/), "VA");
    await user.clear(field("Country code"));
    await user.type(field("Country code"), "us");
    await user.click(
      within(dialog).getByRole("checkbox", { name: "Use as my default billing address" }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Save address" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(sent).toEqual({
      label: null,
      first_name: "Grace",
      last_name: "Hopper",
      company: null,
      line1: "2 Compiler Court",
      line2: null,
      city: "Arlington",
      region: "VA",
      postal_code: null,
      country_code: "US",
      phone: null,
      is_default_shipping: false,
      is_default_billing: true,
    });
    expect(toast.success).toHaveBeenCalledWith("Address added", expect.anything());
    expect(await screen.findByText("Grace Hopper")).toBeInTheDocument();
  });

  it("edits an address without unsetting its current default", async () => {
    let sent: unknown;
    let target: unknown;
    server.use(
      listing(HOME),
      on("patch", "/api/v1/account/addresses/{address_id}", async ({ request, params }) => {
        target = params["address_id"];
        sent = await request.json();
        return HttpResponse.json(HOME);
      }),
    );
    const user = userEvent.setup();
    render(<AddressBook />);
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit address" });
    expect(within(dialog).getByRole("textbox", { name: "Label (optional)" })).toHaveValue("Home");
    const shipping = within(dialog).getByRole("checkbox", {
      name: "Use as my default shipping address",
    });
    expect(shipping).toBeChecked();
    expect(shipping).toBeDisabled();
    const city = within(dialog).getByRole("textbox", { name: "City" });
    await user.clear(city);
    await user.type(city, "Cambridge");
    await user.click(within(dialog).getByRole("button", { name: "Save address" }));
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Address updated", expect.anything());
    });
    expect(target).toBe("home");
    expect(sent).toMatchObject({
      city: "Cambridge",
      label: "Home",
      is_default_shipping: true,
      is_default_billing: true,
    });
  });

  it("sends null, not false, for a default left unset when editing", async () => {
    let sent: unknown;
    server.use(
      listing(WORK),
      on("patch", "/api/v1/account/addresses/{address_id}", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(WORK);
      }),
    );
    const user = userEvent.setup();
    render(<AddressBook />);
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit address" });
    await user.click(within(dialog).getByRole("button", { name: "Save address" }));
    await waitFor(() => {
      expect(sent).toMatchObject({ is_default_shipping: null, is_default_billing: null });
    });
  });

  it("shows field errors inline and keeps the dialog open", async () => {
    server.use(
      listing(),
      fail("post", "/api/v1/account/addresses", {
        status: 422,
        slug: "validation-failed",
        errors: [{ field: "postal_code", code: "invalid", message: "Enter a valid ZIP code" }],
      }),
    );
    const user = userEvent.setup();
    render(<AddressBook />);
    await user.click(await screen.findByRole("button", { name: "Add an address" }));
    const dialog = await screen.findByRole("dialog", { name: "Add an address" });
    await user.click(within(dialog).getByRole("button", { name: "Save address" }));
    const postal = within(dialog).getByRole("textbox", { name: "Postal code (optional)" });
    await waitFor(() => {
      expect(postal).toHaveAccessibleDescription("Enter a valid ZIP code");
    });
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a form-level problem in the dialog", async () => {
    server.use(
      listing(),
      fail("post", "/api/v1/account/addresses", {
        status: 409,
        title: "Too many addresses",
        detail: "Delete one first.",
      }),
    );
    const user = userEvent.setup();
    render(<AddressBook />);
    await user.click(await screen.findByRole("button", { name: "Add an address" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Save address" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Too many addressesDelete one first.",
    );
  });

  it("closes the dialog on cancel without saving", async () => {
    server.use(listing());
    const user = userEvent.setup();
    render(<AddressBook />);
    await user.click(await screen.findByRole("button", { name: "Add an address" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("closes the dialog on Escape", async () => {
    server.use(listing(HOME));
    const user = userEvent.setup();
    render(<AddressBook />);
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("confirms a delete naming the address, then reloads", async () => {
    let deleted: unknown;
    let loads = 0;
    server.use(
      on("get", "/api/v1/account/addresses", () => {
        loads += 1;
        return HttpResponse.json(loads === 1 ? [WORK] : []);
      }),
      on("delete", "/api/v1/account/addresses/{address_id}", ({ params }) => {
        deleted = params["address_id"];
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    render(<AddressBook />);
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Delete 2 Compiler Court, Floor 3, Arlington, VA, 22201?",
    });
    expect(dialog).toHaveAccessibleDescription("This cannot be undone.");
    await user.click(within(dialog).getByRole("button", { name: "Delete address" }));
    expect(await screen.findByText(/No saved addresses/)).toBeInTheDocument();
    expect(deleted).toBe("work");
    expect(toast.success).toHaveBeenCalledWith("Address deleted", expect.anything());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("explains why a delete was refused", async () => {
    server.use(
      listing(HOME),
      fail("delete", "/api/v1/account/addresses/{address_id}", {
        status: 409,
        title: "This is your default address",
        detail: "Choose another default first.",
      }),
    );
    const user = userEvent.setup();
    render(<AddressBook />);
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Home?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete address" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "This is your default addressChoose another default first.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Keep it" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("closes the delete dialog on Escape", async () => {
    server.use(listing(HOME));
    const user = userEvent.setup();
    render(<AddressBook />);
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});
