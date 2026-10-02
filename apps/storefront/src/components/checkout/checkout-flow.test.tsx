import type { Schema } from "@velo/api-client";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { CheckoutFlow } from "@/components/checkout/checkout-flow";
import { rememberCheckout, rememberedCheckout } from "@/lib/checkout-session";
import {
  makeAddressOut,
  makeCheckout,
  makeShippingMethod,
  usd,
} from "@/test/fixtures/checkout-orders";
import { router } from "@/test/navigation";
import { fail, ok, on, server } from "@/test/server";

type Checkout = Schema<"CheckoutView">;

const initiated = makeCheckout();
const addressSet = makeCheckout({ status: "address_set", shipping_address: makeAddressOut() });
const shippingSet = makeCheckout({
  status: "shipping_set",
  shipping_address: makeAddressOut(),
  shipping_method: makeShippingMethod(),
  totals: { ...initiated.totals, shipping: usd(500), total: usd(9500) },
});

const rates: Schema<"ShippingRatesView"> = {
  selected_id: null,
  options: [
    makeShippingMethod(),
    makeShippingMethod({
      id: "rate-express",
      name: "Express",
      price: usd(1500),
      est_days_min: 1,
      est_days_max: 1,
    }),
    makeShippingMethod({
      id: "rate-pickup",
      name: "Pickup",
      price: usd(0),
      est_days_min: null,
      est_days_max: null,
    }),
    makeShippingMethod({
      id: "rate-freight",
      name: "Freight",
      price: usd(4000),
      est_days_min: null,
      est_days_max: 2,
    }),
  ],
};

/** Start the flow as a tab that already has a checkout in progress. */
function resume(checkout: Checkout) {
  rememberCheckout(checkout.id);
  server.use(ok("get", "/api/v1/checkout/{checkout_id}", checkout));
}

function panel(name: RegExp) {
  return screen.getByRole("region", { name });
}

function progress() {
  return within(screen.getByRole("navigation", { name: "Checkout progress" }));
}

async function fillShipping(user: ReturnType<typeof userEvent.setup>, scope = document.body) {
  const form = within(scope);
  await user.type(form.getByLabelText("First name"), "Grace");
  await user.type(form.getByLabelText("Last name"), "Hopper");
  await user.type(form.getByLabelText("Address"), "2 Navy Yard");
  await user.type(form.getByLabelText("Town or city"), "Arlington");
  await user.type(form.getByLabelText("State"), "VA");
  await user.type(form.getByLabelText("ZIP code"), "22201");
}

describe("CheckoutFlow — contact", () => {
  it("asks a guest for a valid email before starting", async () => {
    render(<CheckoutFlow accountEmail={null} />);
    const user = userEvent.setup();
    expect(screen.getByRole("heading", { name: "Checkout" })).toBeInTheDocument();
    expect(progress().getByText("Step 1 of 4 · Contact")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/sign-in?next=/checkout",
    );
    const email = screen.getByLabelText("Email");
    await user.type(email, "not-an-email");
    await user.click(screen.getByRole("button", { name: "Continue to delivery" }));
    expect(email).toHaveAccessibleDescription(
      expect.stringContaining("Enter an email address like name@example.com."),
    );
    await user.type(email, "x");
    expect(email).not.toHaveAttribute("aria-invalid");
  });

  it("starts a guest checkout and moves to delivery", async () => {
    let sent: unknown;
    let key: string | null = null;
    server.use(
      on("post", "/api/v1/checkout", async ({ request }) => {
        sent = await request.json();
        key = request.headers.get("Idempotency-Key");
        return HttpResponse.json(initiated, { status: 201 });
      }),
    );
    render(<CheckoutFlow accountEmail={null} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.click(screen.getByRole("button", { name: "Continue to delivery" }));

    const heading = await screen.findByRole("heading", { name: "2. Delivery" });
    expect(heading).toHaveFocus();
    expect(sent).toEqual({ email: "ada@example.com" });
    expect(key).toBeTruthy();
    expect(rememberedCheckout()).toBe("chk_1");
    expect(panel(/1\. Contact/)).toHaveTextContent("ada@example.com");
    expect(progress().getByRole("button", { name: "Contact (completed)" })).toBeDisabled();
    const summary = screen.getByRole("region", { name: "Order summary" });
    expect(summary).toHaveTextContent("Trail Runner");
    expect(summary).toHaveTextContent("Size 9 × 2");
    expect(summary).toHaveTextContent("Items are held until");
  });

  it("uses the account email for a signed-in customer", async () => {
    let sent: unknown;
    server.use(
      on("post", "/api/v1/checkout", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(initiated, { status: 201 });
      }),
      ok("get", "/api/v1/account/addresses", []),
    );
    render(<CheckoutFlow accountEmail="ada@example.com" />);
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Continue to delivery" }));
    await screen.findByRole("heading", { name: "2. Delivery" });
    expect(sent).toEqual({});
  });

  it("lists sold-out items and links back to the cart", async () => {
    server.use(
      fail("post", "/api/v1/checkout", {
        status: 409,
        slug: "out-of-stock",
        title: "Out of stock",
        errors: [
          { field: "items.0", code: "invalid", message: "Trail Runner: only 1 left." },
          { field: "items.1", code: "invalid", message: "Wool Sock is sold out." },
        ],
      }),
    );
    render(<CheckoutFlow accountEmail="ada@example.com" />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Continue to delivery" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Some items sold out while you were shopping");
    expect(screen.getByText("Trail Runner: only 1 left.")).toBeInTheDocument();
    expect(screen.getByText("Wool Sock is sold out.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review cart" })).toHaveAttribute("href", "/cart");
  });

  it("explains an empty cart", async () => {
    server.use(fail("post", "/api/v1/checkout", { status: 409, slug: "cart-empty" }));
    render(<CheckoutFlow accountEmail="ada@example.com" />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Continue to delivery" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your cart is empty");
  });

  it("puts a server email error on the field", async () => {
    server.use(
      fail("post", "/api/v1/checkout", {
        status: 422,
        errors: [
          { field: "email", code: "invalid", message: "That domain does not receive email." },
        ],
      }),
    );
    render(<CheckoutFlow accountEmail={null} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), "ada@example.invalid");
    await user.click(screen.getByRole("button", { name: "Continue to delivery" }));
    await waitFor(() => {
      expect(screen.getByLabelText("Email")).toHaveAccessibleDescription(
        expect.stringContaining("That domain does not receive email."),
      );
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows any other problem as an alert", async () => {
    server.use(
      fail("post", "/api/v1/checkout", {
        status: 503,
        title: "Checkout is paused",
        detail: "Back in a minute.",
      }),
    );
    render(<CheckoutFlow accountEmail="ada@example.com" />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Continue to delivery" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Checkout is paused");
    expect(alert).toHaveTextContent("Back in a minute.");
  });
});

describe("CheckoutFlow — resuming", () => {
  it("shows a skeleton while it reads the remembered checkout", async () => {
    resume(addressSet);
    server.use(ok("get", "/api/v1/checkout/{checkout_id}/shipping-rates", rates));
    const { container } = render(<CheckoutFlow accountEmail={null} />);
    expect(container.querySelector("[aria-busy]")).not.toBeNull();
    expect(await screen.findByRole("heading", { name: "3. Shipping" })).toBeInTheDocument();
    expect(panel(/2\. Delivery/)).toHaveTextContent(
      "Ada Lovelace, 1 Market St, San Francisco, 94103, US",
    );
  });

  it("says the checkout timed out when the server has let it go", async () => {
    rememberCheckout("chk_1");
    server.use(fail("get", "/api/v1/checkout/{checkout_id}", { status: 410, slug: "expired" }));
    render(<CheckoutFlow accountEmail={null} />);
    expect(await screen.findByRole("status")).toHaveTextContent("Your checkout timed out");
    expect(rememberedCheckout()).toBeNull();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
  });

  it("forgets an unreadable checkout without alarming the customer", async () => {
    rememberCheckout("chk_1");
    server.use(fail("get", "/api/v1/checkout/{checkout_id}", { status: 404 }));
    render(<CheckoutFlow accountEmail={null} />);
    expect(await screen.findByLabelText("Email")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(rememberedCheckout()).toBeNull();
  });

  it.each([
    makeCheckout({ status: "confirmed" }),
    makeCheckout({
      status: "payment_pending",
      payment: { status: "succeeded", failure_message: null },
    }),
  ])("sends a paid checkout to its confirmation page", async (checkout) => {
    resume(checkout);
    render(<CheckoutFlow accountEmail={null} />);
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith("/checkout/confirmation?checkout=chk_1");
    });
  });

  it("treats an expired session as timed out", async () => {
    resume(makeCheckout({ status: "expired" }));
    render(<CheckoutFlow accountEmail={null} />);
    expect(await screen.findByRole("status")).toHaveTextContent("Your checkout timed out");
    expect(rememberedCheckout()).toBeNull();
  });

  it.each(["abandoned", "failed"] as const)("starts over after an %s session", async (status) => {
    resume(makeCheckout({ status }));
    render(<CheckoutFlow accountEmail={null} />);
    expect(await screen.findByLabelText("Email")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(rememberedCheckout()).toBeNull();
  });
});

describe("CheckoutFlow — delivery", () => {
  it("checks the address locally before saving", async () => {
    resume(initiated);
    render(<CheckoutFlow accountEmail={null} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Continue to shipping" }));
    expect(screen.getByLabelText("First name")).toHaveAccessibleDescription("Enter a first name.");
    expect(screen.getByLabelText("ZIP code")).toHaveAccessibleDescription("Enter a zip code.");
  });

  it("saves the shipping address, with billing the same, and moves on", async () => {
    resume(initiated);
    let sent: unknown;
    server.use(
      on("patch", "/api/v1/checkout/{checkout_id}/address", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(addressSet);
      }),
      ok("get", "/api/v1/checkout/{checkout_id}/shipping-rates", rates),
    );
    render(<CheckoutFlow accountEmail={null} />);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "2. Delivery" });
    expect(
      screen.getByRole("checkbox", { name: "Billing address is the same as shipping" }),
    ).toBeChecked();
    await fillShipping(user);
    await user.type(screen.getByLabelText("Company (optional)"), "  US Navy ");
    await user.click(screen.getByRole("button", { name: "Continue to shipping" }));
    await screen.findByRole("heading", { name: "3. Shipping" });
    expect(sent).toEqual({
      shipping_address: {
        first_name: "Grace",
        last_name: "Hopper",
        company: "US Navy",
        line1: "2 Navy Yard",
        line2: null,
        city: "Arlington",
        region: "VA",
        postal_code: "22201",
        country_code: "US",
        phone: null,
      },
      billing_address: null,
    });
  });

  it("takes a separate billing address when asked", async () => {
    resume(initiated);
    let sent: { billing_address?: { first_name: string } | null } = {};
    server.use(
      on("patch", "/api/v1/checkout/{checkout_id}/address", async ({ request }) => {
        sent = (await request.json()) as typeof sent;
        return HttpResponse.json(addressSet);
      }),
      ok("get", "/api/v1/checkout/{checkout_id}/shipping-rates", rates),
    );
    render(<CheckoutFlow accountEmail={null} />);
    const user = userEvent.setup();
    const shipping = await screen.findByRole("group", { name: "Shipping address" });
    await fillShipping(user, shipping);
    await user.click(
      screen.getByRole("checkbox", { name: "Billing address is the same as shipping" }),
    );
    const billing = screen.getByRole("group", { name: "Billing address" });
    await user.click(screen.getByRole("button", { name: "Continue to shipping" }));
    expect(within(billing).getByLabelText("First name")).toHaveAccessibleDescription(
      "Enter a first name.",
    );
    await fillShipping(user, billing);
    await user.click(screen.getByRole("button", { name: "Continue to shipping" }));
    await screen.findByRole("heading", { name: "3. Shipping" });
    expect(sent.billing_address?.first_name).toBe("Grace");
  });

  it("shows the server's field errors on the right form", async () => {
    resume(initiated);
    server.use(
      fail("patch", "/api/v1/checkout/{checkout_id}/address", {
        status: 422,
        errors: [
          {
            field: "shipping_address.line1",
            code: "invalid",
            message: "We cannot deliver to a PO box.",
          },
        ],
      }),
    );
    render(<CheckoutFlow accountEmail={null} />);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "2. Delivery" });
    await fillShipping(user);
    await user.click(screen.getByRole("button", { name: "Continue to shipping" }));
    await waitFor(() => {
      expect(screen.getByLabelText("Address")).toHaveAccessibleDescription(
        "We cannot deliver to a PO box.",
      );
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a non-field failure as an alert", async () => {
    resume(initiated);
    server.use(
      fail("patch", "/api/v1/checkout/{checkout_id}/address", {
        status: 409,
        title: "We do not ship there yet",
      }),
    );
    render(<CheckoutFlow accountEmail={null} />);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "2. Delivery" });
    await fillShipping(user);
    await user.click(screen.getByRole("button", { name: "Continue to shipping" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("We do not ship there yet");
  });

  it("drops back to the start when the session expired mid-step", async () => {
    resume(initiated);
    server.use(fail("patch", "/api/v1/checkout/{checkout_id}/address", { status: 410 }));
    render(<CheckoutFlow accountEmail={null} />);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "2. Delivery" });
    await fillShipping(user);
    await user.click(screen.getByRole("button", { name: "Continue to shipping" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Your checkout timed out");
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(rememberedCheckout()).toBeNull();
  });

  it("offers a signed-in customer's saved addresses, preferring the default", async () => {
    resume(initiated);
    const saved = (overrides: Partial<Schema<"AddressResponse">>) => ({
      ...makeAddressOut(),
      id: "addr-1",
      label: null,
      created_at: "2026-01-01T00:00:00Z",
      is_default_billing: false,
      is_default_shipping: false,
      ...overrides,
    });
    server.use(
      ok("get", "/api/v1/account/addresses", [
        saved({ id: "addr-1", label: "Work", line1: "9 Office Park", is_default_shipping: true }),
        saved({ id: "addr-2", first_name: "Charles", last_name: "Babbage", line1: "5 Engine Ln" }),
      ]),
    );
    render(<CheckoutFlow accountEmail="ada@example.com" />);
    const savedGroup = await screen.findByRole("group", { name: "Saved addresses" });
    await waitFor(() => {
      expect(screen.getByLabelText("Address")).toHaveValue("9 Office Park");
    });
    await userEvent
      .setup()
      .click(within(savedGroup).getByRole("button", { name: /Charles Babbage/ }));
    expect(screen.getByLabelText("Address")).toHaveValue("5 Engine Ln");
    expect(screen.getByLabelText("First name")).toHaveValue("Charles");
    expect(within(savedGroup).getByRole("button", { name: /Work/ })).toHaveTextContent(
      "9 Office Park, San Francisco, US",
    );
  });

  it("ignores saved addresses it cannot load", async () => {
    resume(initiated);
    server.use(fail("get", "/api/v1/account/addresses", { status: 500 }));
    render(<CheckoutFlow accountEmail="ada@example.com" />);
    await screen.findByRole("heading", { name: "2. Delivery" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("group", { name: "Saved addresses" })).not.toBeInTheDocument();
  });
});

describe("CheckoutFlow — shipping", () => {
  it("lists the rates with honest delivery estimates and saves the choice", async () => {
    resume(addressSet);
    let sent: unknown;
    server.use(
      ok("get", "/api/v1/checkout/{checkout_id}/shipping-rates", rates),
      on("patch", "/api/v1/checkout/{checkout_id}/shipping", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(shippingSet);
      }),
    );
    render(<CheckoutFlow accountEmail={null} />);
    const user = userEvent.setup();
    const standard = await screen.findByRole("radio", { name: /Standard/ });
    expect(standard).toBeChecked();
    expect(standard.closest("label")).toHaveTextContent("3–5 business days$5.00");
    expect(screen.getByRole("radio", { name: /Express/ }).closest("label")).toHaveTextContent(
      "1 business day",
    );
    expect(screen.getByRole("radio", { name: /Pickup/ }).closest("label")).toHaveTextContent(
      "Delivery time variesFree",
    );
    expect(screen.getByRole("radio", { name: /Freight/ }).closest("label")).toHaveTextContent(
      "2 business days",
    );
    await user.click(screen.getByRole("radio", { name: /Express/ }));
    await user.click(screen.getByRole("button", { name: "Continue to payment" }));
    expect(await screen.findByRole("heading", { name: "4. Payment" })).toBeInTheDocument();
    expect(sent).toEqual({ shipping_rate_id: "rate-express" });
    expect(panel(/3\. Shipping/)).toHaveTextContent("Standard · $5.00");
  });

  it("keeps the server's selected rate", async () => {
    resume(addressSet);
    server.use(
      ok("get", "/api/v1/checkout/{checkout_id}/shipping-rates", {
        ...rates,
        selected_id: "rate-pickup",
      }),
    );
    render(<CheckoutFlow accountEmail={null} />);
    expect(await screen.findByRole("radio", { name: /Pickup/ })).toBeChecked();
  });

  it("says when nothing needs shipping", async () => {
    resume(addressSet);
    let sent: unknown;
    server.use(
      ok("get", "/api/v1/checkout/{checkout_id}/shipping-rates", {
        options: [],
        selected_id: null,
      }),
      on("patch", "/api/v1/checkout/{checkout_id}/shipping", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(shippingSet);
      }),
    );
    render(<CheckoutFlow accountEmail={null} />);
    expect(await screen.findByText("Nothing in this order needs shipping.")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Continue to payment" }));
    await screen.findByRole("heading", { name: "4. Payment" });
    expect(sent).toEqual({ shipping_rate_id: null });
  });

  it("says when the rates cannot be loaded", async () => {
    resume(addressSet);
    server.use(fail("get", "/api/v1/checkout/{checkout_id}/shipping-rates", { status: 500 }));
    render(<CheckoutFlow accountEmail={null} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We could not load shipping options",
    );
  });
});

describe("CheckoutFlow — navigating between steps", () => {
  it("lets the customer go back to a completed step and return", async () => {
    resume(shippingSet);
    server.use(ok("get", "/api/v1/checkout/{checkout_id}/shipping-rates", rates));
    render(<CheckoutFlow accountEmail={null} />);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "4. Payment" });
    expect(progress().getByRole("button", { name: "Payment" })).toHaveAttribute(
      "aria-current",
      "step",
    );

    await user.click(screen.getByRole("button", { name: "Edit delivery" }));
    expect(screen.getByRole("heading", { name: "2. Delivery" })).toHaveFocus();
    expect(screen.getByLabelText("Address")).toHaveValue("1 Market St");

    await user.click(progress().getByRole("button", { name: "Shipping (completed)" }));
    expect(await screen.findByRole("radio", { name: /Standard/ })).toBeInTheDocument();

    await user.click(progress().getByRole("button", { name: "Payment" }));
    expect(screen.getByRole("button", { name: "Continue to secure payment" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Edit shipping" }));
    expect(screen.getByRole("heading", { name: "3. Shipping" })).toHaveFocus();
  });

  it("locks earlier steps once payment is under way", async () => {
    resume(makeCheckout({ ...shippingSet, status: "payment_pending" }));
    server.use(
      fail("post", "/api/v1/checkout/{checkout_id}/payment-intent", {
        status: 500,
        title: "Payment service error",
      }),
    );
    render(<CheckoutFlow accountEmail={null} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Payment service error");
    expect(screen.queryByRole("button", { name: /^Edit/ })).not.toBeInTheDocument();
    expect(progress().getByRole("button", { name: "Delivery (completed)" })).toBeDisabled();
  });

  it("re-reads the checkout when the total changes at payment", async () => {
    resume(shippingSet);
    let reads = 0;
    server.use(
      on("get", "/api/v1/checkout/{checkout_id}", () => {
        reads += 1;
        return HttpResponse.json(
          reads === 1
            ? shippingSet
            : makeCheckout({ ...shippingSet, totals: { ...shippingSet.totals, total: usd(9900) } }),
        );
      }),
      fail("post", "/api/v1/checkout/{checkout_id}/payment-intent", {
        status: 409,
        slug: "price-changed",
      }),
    );
    render(<CheckoutFlow accountEmail={null} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Continue to secure payment" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The total changed before we charged anything",
    );
    await waitFor(() => {
      expect(reads).toBe(2);
    });
    expect(await screen.findAllByText("$99.00")).not.toHaveLength(0);
  });
});
