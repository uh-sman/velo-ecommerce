import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PaymentStep } from "@/components/checkout/payment-step";
import {
  makeAddressOut,
  makeCheckout,
  makeIntent,
  makeShippingMethod,
} from "@/test/fixtures/checkout-orders";
import { router } from "@/test/navigation";
import { fail, ok, on, server } from "@/test/server";

/*
 * Stripe's Elements render cross-origin iframes, so the SDK is replaced by a
 * fake whose `submit`/`confirmPayment` each test scripts. What is under test
 * is our logic around it: the amount, the review, and how outcomes are shown.
 */
const stripeFake = vi.hoisted(() => ({
  submit: vi.fn<() => Promise<{ error?: { message?: string } }>>(),
  confirmPayment:
    vi.fn<(options: unknown) => Promise<{ error?: { type: string; message?: string } }>>(),
}));

vi.mock("@stripe/stripe-js", () => ({ loadStripe: vi.fn(() => Promise.resolve({})) }));

vi.mock("@stripe/react-stripe-js", () => ({
  Elements: ({ children }: { children: ReactNode }) => <>{children}</>,
  ExpressCheckoutElement: ({ onConfirm }: { onConfirm: () => void }) => (
    <button type="button" onClick={onConfirm}>
      Express pay
    </button>
  ),
  PaymentElement: ({ onReady }: { onReady: () => void }) => {
    useEffect(() => {
      onReady();
    }, [onReady]);
    return <div>Card form</div>;
  },
  useStripe: () => ({ confirmPayment: stripeFake.confirmPayment }),
  useElements: () => ({ submit: stripeFake.submit }),
}));

const shippingSet = () =>
  makeCheckout({
    status: "shipping_set",
    shipping_address: makeAddressOut(),
    shipping_method: makeShippingMethod(),
  });

function renderStep(checkout = shippingSet()) {
  const onRepriced = vi.fn();
  const onProblem = vi.fn();
  render(<PaymentStep checkout={checkout} onRepriced={onRepriced} onProblem={onProblem} />);
  return { onRepriced, onProblem };
}

beforeEach(() => {
  stripeFake.submit.mockReset().mockResolvedValue({});
  stripeFake.confirmPayment.mockReset().mockResolvedValue({});
});

afterEach(() => {
  delete window.PaystackPop;
});

describe("PaymentStep — creating the intent", () => {
  it("shows the server total and creates an intent with an idempotency key", async () => {
    let key: string | null = null;
    server.use(
      on("post", "/api/v1/checkout/{checkout_id}/payment-intent", ({ request }) => {
        key = request.headers.get("Idempotency-Key");
        return HttpResponse.json(makeIntent());
      }),
    );
    renderStep();
    expect(screen.getByText("$90.00")).toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Continue to secure payment" }));

    const review = await screen.findByRole("region", { name: "Review your order" });
    expect(review).toHaveTextContent("2 items");
    expect(review).toHaveTextContent("ada@example.com");
    expect(review).toHaveTextContent("Ada Lovelace, 1 Market St, San Francisco 94103, US");
    expect(review).toHaveTextContent("Standard");
    expect(review).toHaveTextContent("$95.00");
    expect(key).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Pay $95.00" })).toBeEnabled();
  });

  it("asks to pay again after a discount ran out, without charging", async () => {
    server.use(
      fail("post", "/api/v1/checkout/{checkout_id}/payment-intent", {
        status: 409,
        slug: "discount-expired",
        title: "Expired",
      }),
    );
    const { onRepriced } = renderStep();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Continue to secure payment" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your discount code has run out");
    expect(onRepriced).toHaveBeenCalled();
  });

  it("hands unknown problems to the page", async () => {
    server.use(
      fail("post", "/api/v1/checkout/{checkout_id}/payment-intent", {
        status: 500,
        title: "Server error",
        detail: "Later.",
      }),
    );
    const { onProblem } = renderStep();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Continue to secure payment" }));
    await waitFor(() => {
      expect(onProblem).toHaveBeenCalledWith({ title: "Server error", detail: "Later." });
    });
  });

  it("resumes an intent already in flight on mount", async () => {
    server.use(ok("post", "/api/v1/checkout/{checkout_id}/payment-intent", makeIntent()));
    renderStep(makeCheckout({ status: "payment_pending" }));
    const review = await screen.findByRole("region", { name: "Review your order" });
    expect(review).not.toHaveTextContent("Delivering to");
    expect(screen.queryByRole("button", { name: "Continue to secure payment" })).toBeNull();
  });
});

describe("PaymentStep — Stripe", () => {
  async function toStripeForm() {
    server.use(ok("post", "/api/v1/checkout/{checkout_id}/payment-intent", makeIntent()));
    renderStep();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Continue to secure payment" }));
    return { user, pay: await screen.findByRole("button", { name: "Pay $95.00" }) };
  }

  it("confirms the payment and goes to the confirmation page", async () => {
    const { user, pay } = await toStripeForm();
    await user.click(pay);
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith("/checkout/confirmation?checkout=chk_1");
    });
    expect(stripeFake.confirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        clientSecret: "pi_secret_1",
        redirect: "if_required",
        confirmParams: {
          return_url: `${window.location.origin}/checkout/confirmation?checkout=chk_1`,
        },
      }),
    );
  });

  it("shows the element's own validation message", async () => {
    stripeFake.submit.mockResolvedValue({ error: { message: "Your card number is incomplete." } });
    const { user, pay } = await toStripeForm();
    await user.click(pay);
    expect(await screen.findByRole("alert")).toHaveTextContent("Your card number is incomplete.");
    expect(stripeFake.confirmPayment).not.toHaveBeenCalled();
  });

  it("falls back to a generic validation message", async () => {
    stripeFake.submit.mockResolvedValue({ error: {} });
    const { user, pay } = await toStripeForm();
    await user.click(pay);
    expect(await screen.findByRole("alert")).toHaveTextContent("Check your payment details.");
  });

  it("shows a card decline as the bank worded it", async () => {
    stripeFake.confirmPayment.mockResolvedValue({
      error: { type: "card_error", message: "Your card has insufficient funds." },
    });
    const { user } = await toStripeForm();
    await user.click(screen.getByRole("button", { name: "Express pay" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your card has insufficient funds.");
    expect(router.push).not.toHaveBeenCalled();
  });

  it("reassures the customer on any other failure", async () => {
    stripeFake.confirmPayment.mockResolvedValue({ error: { type: "api_error" } });
    const { user, pay } = await toStripeForm();
    await user.click(pay);
    expect(await screen.findByRole("alert")).toHaveTextContent("You have not been charged");
  });

  it("uses a default decline message when the card error has none", async () => {
    stripeFake.confirmPayment.mockResolvedValue({ error: { type: "card_error" } });
    const { user, pay } = await toStripeForm();
    await user.click(pay);
    expect(await screen.findByRole("alert")).toHaveTextContent("Your card was declined.");
  });
});

describe("PaymentStep — Paystack", () => {
  const paystack = () =>
    server.use(
      ok(
        "post",
        "/api/v1/checkout/{checkout_id}/payment-intent",
        makeIntent({ provider: "paystack", client_secret: "access_1" }),
      ),
    );

  function installPop(outcome: "success" | "cancel" | "error") {
    const resume = vi.fn(
      (
        _code: string,
        callbacks: { onSuccess: () => void; onCancel: () => void; onError?: (e: unknown) => void },
      ) => {
        if (outcome === "success") callbacks.onSuccess();
        else if (outcome === "cancel") callbacks.onCancel();
        else callbacks.onError?.(new Error("declined"));
      },
    );
    window.PaystackPop = class {
      resumeTransaction = resume;
    };
    return resume;
  }

  it("resumes the Paystack transaction and confirms on success", async () => {
    paystack();
    const resume = installPop("success");
    renderStep();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Continue to secure payment" }));
    await user.click(await screen.findByRole("button", { name: "Pay $95.00" }));
    expect(resume).toHaveBeenCalledWith("access_1", expect.any(Object));
    expect(router.push).toHaveBeenCalledWith("/checkout/confirmation?checkout=chk_1");
  });

  it("re-enables Pay when the customer closes the popup", async () => {
    paystack();
    installPop("cancel");
    renderStep();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Continue to secure payment" }));
    const pay = await screen.findByRole("button", { name: "Pay $95.00" });
    await user.click(pay);
    expect(pay).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("explains a failed Paystack payment", async () => {
    paystack();
    installPop("error");
    renderStep();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Continue to secure payment" }));
    await user.click(await screen.findByRole("button", { name: "Pay $95.00" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The payment did not go through. You have not been charged.",
    );
  });

  it("loads the Paystack script on demand and reports when it cannot", async () => {
    paystack();
    renderStep();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Continue to secure payment" }));
    await user.click(await screen.findByRole("button", { name: "Pay $95.00" }));
    const script = document.head.querySelector<HTMLScriptElement>(
      'script[src="https://js.paystack.co/v2/inline.js"]',
    );
    expect(script).not.toBeNull();
    script?.dispatchEvent(new Event("error"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We could not load the payment form.",
    );
    script?.remove();
  });

  it("continues once the script has loaded", async () => {
    paystack();
    renderStep();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Continue to secure payment" }));
    await user.click(await screen.findByRole("button", { name: "Pay $95.00" }));
    const script = document.head.querySelector<HTMLScriptElement>(
      'script[src="https://js.paystack.co/v2/inline.js"]',
    );
    installPop("success");
    script?.dispatchEvent(new Event("load"));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith("/checkout/confirmation?checkout=chk_1");
    });
    script?.remove();
  });
});

describe("PaymentStep — sandbox", () => {
  const sandbox = () =>
    server.use(
      ok(
        "post",
        "/api/v1/checkout/{checkout_id}/payment-intent",
        makeIntent({ provider: "sandbox", client_secret: "sbx_pi_1_secret_abc" }),
      ),
    );

  async function openPayment() {
    renderStep();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Continue to secure payment" }));
    await screen.findByRole("group", { name: "Sandbox payment — no real money" });
    return user;
  }

  it("sends only the outcome, never a card number, and goes to the confirmation", async () => {
    sandbox();
    let sent: unknown = null;
    server.use(
      on("post", "/api/v1/sandbox/confirm", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({ status: "succeeded", failure_message: null });
      }),
    );
    const user = await openPayment();
    expect(screen.queryByRole("textbox")).toBeNull(); // no card field on our origin
    await user.click(screen.getByRole("button", { name: "Pay $95.00" }));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith("/checkout/confirmation?checkout=chk_1");
    });
    expect(sent).toEqual({ client_secret: "sbx_pi_1_secret_abc", outcome: "succeed" });
  });

  it("shows a decline and lets the shopper pay again", async () => {
    sandbox();
    server.use(
      ok("post", "/api/v1/sandbox/confirm", {
        status: "requires_payment",
        failure_message: "Your card was declined.",
      }),
    );
    const user = await openPayment();
    await user.click(screen.getByRole("radio", { name: /4000 0000 0000 0002/ }));
    const pay = screen.getByRole("button", { name: "Pay $95.00" });
    await user.click(pay);
    expect(await screen.findByRole("alert")).toHaveTextContent("Your card was declined.");
    expect(pay).toBeEnabled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("says nothing was charged when the sandbox refuses", async () => {
    sandbox();
    server.use(
      fail("post", "/api/v1/sandbox/confirm", {
        status: 422,
        slug: "validation-failed",
        title: "This payment cannot be confirmed.",
      }),
    );
    const user = await openPayment();
    await user.click(screen.getByRole("button", { name: "Pay $95.00" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You have not been charged");
  });
});
