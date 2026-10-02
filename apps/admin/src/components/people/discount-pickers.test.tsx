import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import {
  collection,
  cursorPage,
  preview,
  productRow,
  productView,
  variant,
} from "@/test/fixtures/people";
import { fail, ok, on, server } from "@/test/server";

import { EligibilityTester, TargetPicker } from "./discount-pickers";
import { draftToFields, emptyDraft, type Draft, type Target } from "./discount-rules";

const PRODUCTS = "/api/v1/admin/products";
const PRODUCT = "/api/v1/admin/products/{product_id}";
const COLLECTIONS = "/api/v1/admin/collections";
const PREVIEW = "/api/v1/admin/discounts/preview";

function Picker({
  kind,
  initial = [],
  error,
  disabled,
}: {
  kind: "products" | "collections";
  initial?: Target[];
  error?: string;
  disabled?: boolean;
}) {
  const [targets, setTargets] = useState<Target[]>(initial);
  return (
    <TargetPicker
      kind={kind}
      targets={targets}
      onChange={setTargets}
      error={error}
      {...(disabled === undefined ? {} : { disabled })}
    />
  );
}

describe("TargetPicker — products", () => {
  it("searches once typing settles, adds a product as a chip, and removes it", async () => {
    const queries: URLSearchParams[] = [];
    server.use(
      on("get", PRODUCTS, ({ request }) => {
        queries.push(new URL(request.url).searchParams);
        return HttpResponse.json(
          cursorPage([
            productRow(),
            productRow({ id: "p2", title: "Road racer", status: "draft" }),
          ]),
        );
      }),
    );
    const user = userEvent.setup();
    render(<Picker kind="products" />);
    expect(screen.getByText(/No products chosen yet/)).toBeInTheDocument();

    await user.type(screen.getByRole("searchbox", { name: "Add products" }), "trail");
    const add = await screen.findByRole("button", { name: "Add Trail runner" });
    expect(queries).toHaveLength(1);
    expect(queries[0]?.get("q")).toBe("trail");
    expect(queries[0]?.get("limit")).toBe("8");
    expect(screen.getByText("draft")).toBeInTheDocument();

    await user.click(add);
    const chosen = screen.getByRole("list", { name: "Chosen products" });
    expect(within(chosen).getByText("Trail runner")).toBeInTheDocument();
    const added = screen.getByRole("button", { name: "Trail runner added" });
    expect(added).toBeDisabled();
    expect(added).toHaveTextContent("Added");

    await user.click(screen.getByRole("button", { name: "Remove Trail runner" }));
    expect(screen.queryByRole("list", { name: "Chosen products" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Trail runner" })).toBeEnabled();
  });

  it("says when nothing matches, and goes quiet when the search is cleared", async () => {
    server.use(ok("get", PRODUCTS, cursorPage([])));
    const user = userEvent.setup();
    render(<Picker kind="products" />);
    const box = screen.getByRole("searchbox", { name: "Add products" });
    await user.type(box, "zzz");
    expect(await screen.findByText("No products match “zzz”.")).toBeInTheDocument();
    await user.clear(box);
    await waitFor(() => {
      expect(screen.queryByText(/No products match/)).not.toBeInTheDocument();
    });
  });

  it("shows a search failure", async () => {
    server.use(fail("get", PRODUCTS, { status: 500, title: "Down", detail: "Search is down." }));
    const user = userEvent.setup();
    render(<Picker kind="products" />);
    await user.type(screen.getByRole("searchbox", { name: "Add products" }), "x");
    expect(await screen.findByText("Search is down.")).toBeInTheDocument();
  });

  it("links its error, and offers no changes when disabled", () => {
    render(
      <Picker
        kind="products"
        initial={[{ id: "p1", label: "Trail runner" }]}
        error="Choose at least one product."
        disabled
      />,
    );
    expect(screen.getByText("Choose at least one product.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Trail runner" })).toBeDisabled();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });
});

describe("TargetPicker — collections", () => {
  it("lists collections, filters them locally, and adds one", async () => {
    server.use(
      ok("get", COLLECTIONS, [
        collection(),
        collection({ id: "k2", title: "Winter", is_active: false, products: [] }),
      ]),
    );
    const user = userEvent.setup();
    render(<Picker kind="collections" />);
    expect(screen.getByText(/No collections chosen yet/)).toBeInTheDocument();

    expect(await screen.findByRole("button", { name: "Add Summer" })).toBeInTheDocument();
    expect(screen.getByText("2 products")).toBeInTheDocument();
    expect(screen.getByText("0 products · hidden")).toBeInTheDocument();

    const filter = screen.getByRole("searchbox", { name: "Add collections" });
    await user.type(filter, "WIN");
    expect(screen.queryByRole("button", { name: "Add Summer" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add Winter" }));
    expect(
      within(screen.getByRole("list", { name: "Chosen collections" })).getByText("Winter"),
    ).toBeInTheDocument();

    await user.clear(filter);
    await user.type(filter, "nothing");
    expect(screen.getByText("No collections match.")).toBeInTheDocument();
  });

  it("says when the store has no collections", async () => {
    server.use(ok("get", COLLECTIONS, []));
    render(<Picker kind="collections" />);
    expect(await screen.findByText("There are no collections yet.")).toBeInTheDocument();
  });

  it("shows a load failure and retries", async () => {
    server.use(fail("get", COLLECTIONS, { status: 500, title: "Collections unavailable" }));
    const user = userEvent.setup();
    render(<Picker kind="collections" />);
    expect(await screen.findByText(/Collections unavailable/)).toBeInTheDocument();
    server.use(ok("get", COLLECTIONS, [collection()]));
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Add Summer" })).toBeInTheDocument();
  });
});

describe("EligibilityTester", { timeout: 20_000 }, () => {
  const DRAFT: Draft = { ...emptyDraft(), title: "Spring", value: "20", code: "spring" };

  const TWO_VARIANTS = productView({
    variants: [
      variant(),
      variant({
        id: "v2",
        title: "Size 10",
        sku: "TR-10",
        price: { amount: 5500, currency: "USD" },
      }),
    ],
  });

  /** Search, choose the product, and add a variant at a quantity. */
  async function addToBasket(
    user: ReturnType<typeof userEvent.setup>,
    { variantId, quantity }: { variantId?: string; quantity?: string } = {},
  ) {
    await user.click(screen.getByRole("searchbox", { name: "Add a product to the test basket" }));
    await user.paste("trail");
    await user.click(await screen.findByRole("button", { name: "Choose Trail runner" }));
    const select = await screen.findByRole("combobox", { name: "Variant" });
    if (variantId) await user.selectOptions(select, variantId);
    if (quantity !== undefined) {
      const field = screen.getByRole("spinbutton", { name: "Quantity" });
      await user.clear(field);
      if (quantity) await user.type(field, quantity);
    }
    await user.click(screen.getByRole("button", { name: "Add to test basket" }));
  }

  function withProducts() {
    server.use(
      ok(
        "get",
        PRODUCTS,
        cursorPage([productRow(), productRow({ id: "p9", title: "Gift card", price: null })]),
      ),
      ok("get", PRODUCT, TWO_VARIANTS),
    );
  }

  it("cannot test an empty basket", () => {
    render(<EligibilityTester draft={DRAFT} />);
    expect(screen.getByRole("button", { name: "Test this basket" })).toBeDisabled();
    expect(screen.getByText("Add at least one product to test.")).toBeInTheDocument();
  });

  it("builds a basket, merges repeat lines, and prices it with the rule as drafted", async () => {
    withProducts();
    let sent: unknown;
    server.use(
      on("post", PREVIEW, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(
          preview({
            shipping_discounted: true,
            lines: [
              {
                variant_id: "v2",
                title: "Trail runner — Size 10",
                quantity: 3,
                subtotal: 16500,
                discount: 3300,
              },
              { title: "Mystery", quantity: "x", subtotal: null },
            ],
          }),
        );
      }),
    );
    const user = userEvent.setup();
    render(<EligibilityTester draft={DRAFT} />);
    await addToBasket(user, { variantId: "v2", quantity: "2" });
    await addToBasket(user, { variantId: "v2" });

    const basket = screen.getByRole("list", { name: "Test basket" });
    expect(within(basket).getAllByRole("listitem")).toHaveLength(1);
    expect(
      within(basket).getByRole("spinbutton", { name: "Quantity of Trail runner — Size 10" }),
    ).toHaveValue(3);

    await user.click(screen.getByRole("textbox", { name: /Customer email/ }));
    await user.paste(" ada@example.com ");
    await user.click(screen.getByRole("button", { name: "Test this basket" }));

    expect(
      await screen.findByText("Eligible — this basket gets the discount."),
    ).toBeInTheDocument();
    expect(sent).toEqual({
      discount: draftToFields(DRAFT),
      lines: [{ variant_id: "v2", quantity: 3 }],
      customer_email: "ada@example.com",
    });
    expect(
      screen.getByText("Shipping will be free at checkout; the saving shows there."),
    ).toBeVisible();
    expect(screen.getByText("$100.00")).toBeInTheDocument();
    expect(screen.getByText("$80.00")).toBeInTheDocument();
    expect(screen.getByText("3 × Trail runner — Size 10")).toBeInTheDocument();
    expect(screen.getByText("−$33.00")).toBeInTheDocument();
    expect(screen.getByText("0 × Mystery")).toBeInTheDocument();

    // Changing the basket discards a result that no longer describes it.
    await user.type(screen.getByRole("textbox", { name: /Customer email/ }), "x");
    expect(screen.queryByText(/^Eligible/)).not.toBeInTheDocument();
  });

  it("edits and removes basket lines", async () => {
    withProducts();
    const user = userEvent.setup();
    render(<EligibilityTester draft={DRAFT} />);
    await addToBasket(user, { quantity: "" });
    const qty = screen.getByRole("spinbutton", { name: "Quantity of Trail runner — Size 9" });
    // A blank quantity in the chooser means one.
    expect(qty).toHaveValue(1);
    await user.clear(qty);
    expect(qty).toHaveValue(1);
    await user.type(qty, "5");
    expect(qty).toHaveValue(15);

    await user.click(
      screen.getByRole("button", { name: "Remove Trail runner — Size 9 from the test basket" }),
    );
    expect(screen.queryByRole("list", { name: "Test basket" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test this basket" })).toBeDisabled();
  });

  it("lets the operator back out of a chosen product", async () => {
    withProducts();
    const user = userEvent.setup();
    render(<EligibilityTester draft={DRAFT} />);
    await user.type(
      screen.getByRole("searchbox", { name: "Add a product to the test basket" }),
      "trail",
    );
    await user.click(await screen.findByRole("button", { name: "Choose Trail runner" }));
    await user.click(await screen.findByRole("button", { name: "Choose another product" }));
    expect(screen.queryByRole("combobox", { name: "Variant" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose Gift card" })).toBeInTheDocument();
  });

  it("explains a product without variants", async () => {
    server.use(
      ok("get", PRODUCTS, cursorPage([productRow()])),
      ok("get", PRODUCT, productView({ variants: [] })),
    );
    const user = userEvent.setup();
    render(<EligibilityTester draft={DRAFT} />);
    await user.type(
      screen.getByRole("searchbox", { name: "Add a product to the test basket" }),
      "trail",
    );
    await user.click(await screen.findByRole("button", { name: "Choose Trail runner" }));
    expect(await screen.findByText("This product has no variants to add.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add to test basket" })).toBeDisabled();
  });

  it("shows search results states and a product that fails to load", async () => {
    server.use(
      on("get", PRODUCTS, ({ request }) => {
        const q = new URL(request.url).searchParams.get("q");
        if (q === "none") return HttpResponse.json(cursorPage([]));
        if (q === "boom") {
          return HttpResponse.json(
            { type: "https://velo.dev/errors/x", title: "Search failed", status: 500 },
            { status: 500 },
          );
        }
        return HttpResponse.json(cursorPage([productRow()]));
      }),
      fail("get", PRODUCT, { status: 404, title: "Product gone" }),
    );
    const user = userEvent.setup();
    render(<EligibilityTester draft={DRAFT} />);
    const box = screen.getByRole("searchbox", { name: "Add a product to the test basket" });

    await user.type(box, "none");
    expect(await screen.findByText("No products match “none”.")).toBeInTheDocument();
    await user.clear(box);
    await user.type(box, "boom");
    expect(await screen.findByText("Search failed")).toBeInTheDocument();
    await user.clear(box);
    await user.type(box, "trail");
    await user.click(await screen.findByRole("button", { name: "Choose Trail runner" }));
    expect(await screen.findByText("Product gone")).toBeInTheDocument();
  });

  describe("results", () => {
    async function testWith(body: ReturnType<typeof preview>) {
      withProducts();
      server.use(ok("post", PREVIEW, body));
      const user = userEvent.setup();
      render(<EligibilityTester draft={DRAFT} />);
      await addToBasket(user);
      await user.click(screen.getByRole("button", { name: "Test this basket" }));
      return user;
    }

    it("gives the customer's reason first", async () => {
      await testWith(
        preview({
          eligible: false,
          discount: 0,
          total: 10000,
          customer_problem: "This customer has already ordered.",
          cart_problem: "min_subtotal",
        }),
      );
      expect(await screen.findByText("Not eligible.")).toBeInTheDocument();
      expect(screen.getByText("This customer has already ordered.")).toBeInTheDocument();
    });

    it("explains a known basket problem in words", async () => {
      await testWith(preview({ eligible: false, discount: 0, cart_problem: "min_subtotal" }));
      expect(
        await screen.findByText("The basket is below the minimum order amount."),
      ).toBeInTheDocument();
    });

    it("names an unknown basket problem by its code", async () => {
      await testWith(preview({ eligible: false, discount: 0, cart_problem: "solar_flare" }));
      expect(
        await screen.findByText("The basket does not qualify (solar_flare)."),
      ).toBeInTheDocument();
    });

    it("has a fallback when there is no reason", async () => {
      await testWith(preview({ eligible: false, discount: 0 }));
      expect(await screen.findByText("It does not apply to this basket.")).toBeInTheDocument();
    });
  });

  describe("problems", () => {
    async function failWith(init: Parameters<typeof fail>[2]) {
      withProducts();
      server.use(fail("post", PREVIEW, init));
      const user = userEvent.setup();
      render(<EligibilityTester draft={DRAFT} />);
      await addToBasket(user);
      await user.click(screen.getByRole("button", { name: "Test this basket" }));
    }

    it("points at the rule when the draft itself is invalid", async () => {
      await failWith({
        status: 422,
        title: "Invalid",
        errors: [
          { field: "discount.value", code: "range", message: "must be at most 100" },
          { field: "discount", code: "x", message: "is incomplete" },
          { field: "lines.0.quantity", code: "range", message: "too many" },
          { field: "customer_email", code: "email", message: "Not an email address." },
        ],
      });
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Fix the rule above before testing it.");
      const items = within(alert).getAllByRole("listitem");
      expect(items.map((item) => item.textContent)).toEqual([
        "value: must be at most 100",
        ": is incomplete",
      ]);
      expect(screen.getByRole("textbox", { name: /Customer email/ })).toHaveAccessibleDescription(
        /Not an email address\./,
      );
    });

    it("shows any other problem by its detail", async () => {
      await failWith({ status: 503, title: "Unavailable", detail: "Pricing is restarting." });
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Pricing is restarting.");
      expect(within(alert).queryByRole("list")).not.toBeInTheDocument();
    });
  });
});
