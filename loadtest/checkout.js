// k6: 500 shoppers checking out at once (PLANNING.md Phase 13).
//
// Every virtual user is a guest with its own cookie jar: add to cart, start a
// checkout, address, shipping, payment intent, pay — through the sandbox
// provider, so no card network is involved. Stock is deliberately short
// (STOCK units for VUS shoppers): the run proves the oversell guard holds under
// load, not just that a quiet store can sell.
//
//   pnpm loadtest            (docker; API on :8000 with VELO_PAYMENT_SANDBOX=true)
//
// Pass/fail is the thresholds block: p95 latency per step, and the number of
// checkouts that reserved stock never exceeding the stock there was.

import http from "k6/http";
import { check, fail } from "k6";
import { Counter, Trend } from "k6/metrics";
import exec from "k6/execution";

const API = __ENV.API_URL || "http://host.docker.internal:8000";
const VUS = Number(__ENV.VUS || 500);
const STOCK = Number(__ENV.STOCK || 200);
const ADMIN_EMAIL = __ENV.ADMIN_EMAIL || "admin@velo.dev";
const ADMIN_PASSWORD = __ENV.ADMIN_PASSWORD || "ChangeMe123!";

const reserved = new Counter("checkouts_reserved");
const outOfStock = new Counter("checkouts_out_of_stock");
const paid = new Counter("payments_confirmed");
const unexpected = new Counter("unexpected_responses");
const checkoutStart = new Trend("step_checkout_start", true);
const paymentIntent = new Trend("step_payment_intent", true);

export const options = {
  scenarios: {
    rush: {
      executor: "per-vu-iterations",
      vus: VUS,
      iterations: 1,
      maxDuration: "5m",
    },
  },
  thresholds: {
    http_req_failed: [{ threshold: "rate<0.01", abortOnFail: false }],
    "http_req_duration{expected_response:true}": ["p(95)<800"],
    step_checkout_start: ["p(95)<1000"],
    step_payment_intent: ["p(95)<1500"],
    // Zero oversells: no more checkouts hold stock than there was stock.
    checkouts_reserved: [`count<=${STOCK}`],
    unexpected_responses: ["count==0"],
  },
};

const ADDRESS = {
  first_name: "Load",
  last_name: "Tester",
  line1: "1 Market St",
  city: "San Francisco",
  region: "CA",
  postal_code: "94103",
  country_code: "US",
};

function csrf(jar) {
  const cookies = jar.cookiesForURL(API);
  return (cookies.velo_csrf || [""])[0];
}

function send(method, path, body, extraHeaders) {
  const jar = http.cookieJar();
  const headers = Object.assign(
    { "Content-Type": "application/json", "X-CSRF-Token": csrf(jar) },
    extraHeaders || {},
  );
  return http.request(method, `${API}${path}`, body ? JSON.stringify(body) : null, { headers });
}

function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ── Setup: an admin makes the scarce product ──────────────────────────────────

export function setup() {
  http.get(`${API}/api/v1/system/health`); // first contact hands out the CSRF cookie
  const login = send("POST", "/api/v1/auth/login", {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  if (login.status !== 200) fail(`admin sign-in failed: ${login.status} ${login.body}`);
  const sku = `LOAD-${Date.now()}`;
  const made = send("POST", "/api/v1/admin/products", {
    title: `Load test ${sku}`,
    status: "active",
    variants: [{ sku, price: 2500, stock: STOCK, options: {} }],
  });
  if (made.status !== 201) fail(`product create failed: ${made.status} ${made.body}`);
  return { variantId: made.json("variants.0.id"), sku };
}

// ── Each shopper ──────────────────────────────────────────────────────────────

export default function (data) {
  http.get(`${API}/api/v1/system/health`);

  const added = send("POST", "/api/v1/cart/items", { variant_id: data.variantId, quantity: 1 });
  if (!check(added, { "added to cart": (r) => r.status === 200 })) {
    unexpected.add(1);
    return;
  }

  const started = send(
    "POST",
    "/api/v1/checkout",
    { email: `shopper${exec.vu.idInTest}@load.test` },
    { "Idempotency-Key": uuid() },
  );
  checkoutStart.add(started.timings.duration);
  if (started.status === 409) {
    outOfStock.add(1); // the expected answer for everyone after the last unit
    return;
  }
  if (!check(started, { "checkout reserved": (r) => r.status === 201 })) {
    unexpected.add(1);
    return;
  }
  reserved.add(1);
  const checkoutId = started.json("id");

  const addressed = send("PATCH", `/api/v1/checkout/${checkoutId}/address`, {
    shipping_address: ADDRESS,
  });
  const rates = http.get(`${API}/api/v1/checkout/${checkoutId}/shipping-rates`);
  const shipped = send("PATCH", `/api/v1/checkout/${checkoutId}/shipping`, {
    shipping_rate_id: rates.json("options.0.id"),
  });
  if (
    !check(shipped, {
      "address and shipping": () => addressed.status === 200 && shipped.status === 200,
    })
  ) {
    unexpected.add(1);
    return;
  }

  const intent = send("POST", `/api/v1/checkout/${checkoutId}/payment-intent`, null, {
    "Idempotency-Key": uuid(),
  });
  paymentIntent.add(intent.timings.duration);
  if (!check(intent, { "payment intent": (r) => r.status === 201 })) {
    unexpected.add(1);
    return;
  }

  const confirmed = send("POST", "/api/v1/sandbox/confirm", {
    client_secret: intent.json("client_secret"),
    outcome: "succeed",
  });
  if (check(confirmed, { paid: (r) => r.status === 200 })) paid.add(1);
  else unexpected.add(1);
}

// ── Teardown: the stock never went negative ───────────────────────────────────

export function teardown(data) {
  http.get(`${API}/api/v1/system/health`);
  send("POST", "/api/v1/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  const stock = http.get(`${API}/api/v1/admin/inventory?q=${encodeURIComponent(data.sku)}`);
  const row = stock.json("items.0");
  check(row, {
    "stock never negative": (r) => r && r.stock.quantity_on_hand >= 0 && r.stock.available >= 0,
  });
}
