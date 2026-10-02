import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { OrderLookupForm } from "@/components/orders/order-lookup";
import { makeOrder } from "@/test/fixtures/checkout-orders";
import { router } from "@/test/navigation";
import { fail, on, server } from "@/test/server";

async function fillAndSubmit(number = " vlo-abc123 ", email = " ada@example.com ") {
  const user = userEvent.setup();
  if (number) await user.type(screen.getByLabelText("Order number"), number);
  if (email) await user.type(screen.getByLabelText("Email"), email);
  await user.click(screen.getByRole("button", { name: "Find my order" }));
}

describe("OrderLookupForm", () => {
  it("asks for both fields before calling the API", async () => {
    render(<OrderLookupForm />);
    await fillAndSubmit("VLO-1", "");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter both your order number and your email.",
    );
  });

  it("normalises the input and opens the order's signed link", async () => {
    let sent: unknown;
    server.use(
      on("post", "/api/v1/orders/lookup", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(makeOrder({ access_token: "tok-1" }));
      }),
    );
    render(<OrderLookupForm />);
    await fillAndSubmit();
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith("/orders/VLO-ABC123?token=tok-1");
    });
    expect(sent).toEqual({ number: "VLO-ABC123", email: "ada@example.com" });
  });

  it("still navigates when the response carries no token", async () => {
    server.use(on("post", "/api/v1/orders/lookup", () => HttpResponse.json(makeOrder())));
    render(<OrderLookupForm />);
    await fillAndSubmit();
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith("/orders/VLO-ABC123?token=");
    });
  });

  it("explains a miss without saying which part was wrong", async () => {
    server.use(fail("post", "/api/v1/orders/lookup", { status: 404, title: "Not found" }));
    render(<OrderLookupForm />);
    await fillAndSubmit();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No order matches that number and email",
    );
    expect(router.push).not.toHaveBeenCalled();
  });

  it("tells a rate-limited visitor how long to wait", async () => {
    server.use(
      fail("post", "/api/v1/orders/lookup", {
        status: 429,
        title: "Too many",
        headers: { "Retry-After": "600" },
      }),
    );
    render(<OrderLookupForm />);
    await fillAndSubmit();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many attempts. Try again in 10 minutes.",
    );
  });

  it("assumes an hour when a 429 has no Retry-After", async () => {
    server.use(fail("post", "/api/v1/orders/lookup", { status: 429, title: "Too many" }));
    render(<OrderLookupForm />);
    await fillAndSubmit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Try again in 60 minutes.");
  });

  it("shows the problem title for anything else", async () => {
    server.use(fail("post", "/api/v1/orders/lookup", { status: 503, title: "Down for upkeep" }));
    render(<OrderLookupForm />);
    await fillAndSubmit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Down for upkeep");
  });
});
