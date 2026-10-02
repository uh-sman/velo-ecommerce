import { render, screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Confirmation } from "@/components/checkout/confirmation";
import { rememberCheckout, rememberedCheckout } from "@/lib/checkout-session";
import {
  makeAddressOut,
  makeCheckout,
  makeOrder,
  makeShippingMethod,
} from "@/test/fixtures/checkout-orders";
import { fail, ok, on, server } from "@/test/server";

const confirmed = makeCheckout({
  status: "confirmed",
  order_number: "VLO-ABC123",
  shipping_address: makeAddressOut({ line2: "Apt 4" }),
  shipping_method: makeShippingMethod({ est_days_max: 5 }),
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Confirmation", () => {
  it("says the checkout cannot be found when there is no id", () => {
    render(<Confirmation checkoutId={null} redirectStatus={null} />);
    expect(screen.getByRole("heading", { name: "We could not find this checkout" })).toHaveFocus();
    expect(screen.getByRole("link", { name: "Continue shopping" })).toHaveAttribute("href", "/");
  });

  it("shows a failed bank redirect without polling", () => {
    render(<Confirmation checkoutId="chk_1" redirectStatus="failed" />);
    expect(screen.getByRole("heading", { name: "Payment not completed" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("You have not been charged");
    expect(screen.getByRole("link", { name: "Back to payment" })).toHaveAttribute(
      "href",
      "/checkout",
    );
  });

  it("treats a 404 as a missing checkout", async () => {
    server.use(fail("get", "/api/v1/checkout/{checkout_id}", { status: 404 }));
    render(<Confirmation checkoutId="chk_1" redirectStatus={null} />);
    expect(
      await screen.findByRole("heading", { name: "We could not find this checkout" }),
    ).toBeInTheDocument();
  });

  it("confirms the order, forgets the session and links to the signed order page", async () => {
    rememberCheckout("chk_1");
    let lookup: unknown;
    server.use(
      ok("get", "/api/v1/checkout/{checkout_id}", confirmed),
      on("post", "/api/v1/orders/lookup", async ({ request }) => {
        lookup = await request.json();
        return HttpResponse.json(makeOrder({ access_token: "tok-9" }));
      }),
    );
    render(<Confirmation checkoutId="chk_1" redirectStatus="succeeded" />);
    expect(
      await screen.findByRole("heading", { name: "Order confirmed — thank you, Ada" }),
    ).toBeInTheDocument();
    expect(screen.getByText("VLO-ABC123")).toBeInTheDocument();
    expect(screen.getByText("A receipt is on its way to a***@example.com.")).toBeInTheDocument();
    expect(screen.getByText("It arrives in about 5 business days.")).toBeInTheDocument();
    expect(screen.getByText(/1 Market St, Apt 4/)).toBeInTheDocument();
    expect(screen.getByText("Size 9 × 2")).toBeInTheDocument();
    expect(rememberedCheckout()).toBeNull();
    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Track this order" })).toHaveAttribute(
        "href",
        "/orders/VLO-ABC123?token=tok-9",
      );
    });
    expect(lookup).toEqual({ number: "VLO-ABC123", email: "ada@example.com" });
  });

  it("falls back to the lookup page when no signed link is issued", async () => {
    server.use(
      ok(
        "get",
        "/api/v1/checkout/{checkout_id}",
        makeCheckout({ status: "confirmed", order_number: "VLO-ABC123" }),
      ),
      fail("post", "/api/v1/orders/lookup", { status: 429 }),
    );
    render(<Confirmation checkoutId="chk_1" redirectStatus={null} />);
    expect(await screen.findByRole("heading", { name: "Order confirmed" })).toBeInTheDocument();
    expect(screen.getByText("It arrives.")).toBeInTheDocument();
    expect(screen.queryByText("Delivery address")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Track this order" })).toHaveAttribute(
      "href",
      "/orders/lookup",
    );
  });

  it("shows a declined payment as a page state", async () => {
    server.use(
      ok(
        "get",
        "/api/v1/checkout/{checkout_id}",
        makeCheckout({
          status: "payment_pending",
          payment: { status: "failed", failure_message: "Declined" },
        }),
      ),
    );
    render(<Confirmation checkoutId="chk_1" redirectStatus={null} />);
    expect(
      await screen.findByRole("heading", { name: "Payment not completed" }),
    ).toBeInTheDocument();
  });

  it("keeps confirming until the webhook-created order appears", async () => {
    let calls = 0;
    server.use(
      on("get", "/api/v1/checkout/{checkout_id}", () => {
        calls += 1;
        return HttpResponse.json(
          calls === 1 ? makeCheckout({ status: "payment_pending" }) : confirmed,
        );
      }),
      fail("post", "/api/v1/orders/lookup", { status: 404 }),
    );
    render(<Confirmation checkoutId="chk_1" redirectStatus={null} />);
    expect(screen.getByRole("heading", { name: "Confirming your payment…" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("do not refresh or pay again");
    expect(
      await screen.findByRole("heading", { name: /Order confirmed/ }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(calls).toBe(2);
  });

  it("stops polling after three minutes without calling it a failure", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => {
      const value = now;
      now += 200_000;
      return value;
    });
    server.use(fail("get", "/api/v1/checkout/{checkout_id}", { status: 503 }));
    render(<Confirmation checkoutId="chk_1" redirectStatus={null} />);
    expect(
      await screen.findByRole("heading", { name: "Your order is being finalised" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Your payment succeeded");
  });

  it("ignores an answer that arrives after it unmounts", async () => {
    let answered = false;
    server.use(
      on("get", "/api/v1/checkout/{checkout_id}", () => {
        answered = true;
        return HttpResponse.json(confirmed);
      }),
    );
    const { unmount } = render(<Confirmation checkoutId="chk_1" redirectStatus={null} />);
    unmount();
    await waitFor(() => {
      expect(answered).toBe(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });

  it("cancels the next poll when it unmounts between polls", async () => {
    let calls = 0;
    server.use(
      on("get", "/api/v1/checkout/{checkout_id}", () => {
        calls += 1;
        return HttpResponse.json(makeCheckout({ status: "payment_pending" }));
      }),
    );
    const { unmount } = render(<Confirmation checkoutId="chk_1" redirectStatus={null} />);
    await waitFor(() => {
      expect(calls).toBe(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(calls).toBe(1);
  });
});
