# Pricing

How Velo turns a cart into money: which discounts apply, in what order, how shipping and tax are chosen, and where rounding happens. The rules below are implemented in [`apps/api/velo/domains/cart/pricing.py`](../apps/api/velo/domains/cart/pricing.py), a pure module with no database or network access, and are pinned by its tests. If this document and that module disagree, the module is right and this document has a bug.

## 1. What a client can send

A variant and a quantity. That is all. No request carries a price, a discount amount, or a total, so there is nothing to tamper with. Every number in a cart response is computed on the server from `product_variants` at the moment of the request. The cart stores no prices.

The one price-related column a cart holds, `cart_items.seen_price_amount`, is the price last shown for that line. It exists only to warn "the price has changed since you added this", and it is never used to charge.

## 2. Order of operations

1. **Subtotal.** The sum over lines of unit price × quantity, as exact integers.
2. **Product discounts** (percentage, fixed amount, buy-X-get-Y), chosen by the stacking rules in §3.
3. **Shipping.** The cheapest active rate for the address whose bands fit (§5), or the rate the customer chose if it fits. A free-shipping discount then sets shipping to zero.
4. **Tax** on taxable lines after product discounts (§6).
5. **Total** = subtotal − product discounts + shipping + exclusive tax.

Until an address is known, shipping and tax are `null`. They are not zero: zero is a claim, and `null` is the truth. A known address where nothing applies gives an explicit zero.

## 3. Stacking

- **Two classes combine freely.** Product discounts reduce merchandise; shipping discounts (free shipping) reduce shipping. A cart can have both.
- **At most one free-shipping discount** applies, since they all mean the same thing. The customer's code is preferred, then the lowest id.
- **A non-stackable product discount applies alone.** The engine compares each non-stackable discount on its own against all stackable discounts together, and applies whichever saves the customer most.
- **Ties** go first to the choice that includes the customer's code, then to fewer discounts, then to the lowest ids. The result never depends on the order discounts were loaded in.
- **Stackable product discounts apply in a fixed order**, each on what the previous ones left: buy-X-get-Y, then percentage, then fixed amount. Each is capped at what is left, so no line goes below zero.

A code that is valid but loses to a better automatic discount stays on the cart with the warning `discount_outclassed`. It starts applying again if the automatic discount stops qualifying.

## 4. Eligibility

These checks depend on the cart and are made by the engine, against the subtotal **before** any discount:

- minimum subtotal;
- target products or collections (at least one line must match);
- enough matching items for one complete buy-X-get-Y group;
- for fixed-amount discounts, the same currency as the cart;
- for free shipping, at least one line that ships.

These depend on the customer and the calendar, and are checked before the engine runs (`velo/domains/discounts/service.py`):

- the discount is active and inside its date window (the end is exclusive);
- it is under its total redemption limit and this customer's limit;
- first-order-only: a signed-in customer with a paid order is refused. A guest's history is unknown until checkout, so a guest is allowed provisionally and checked again at checkout;
- customer segment: `all`, `returning` (at least one paid order), `subscribers` (opted in to marketing), or `staff`. An unknown segment admits no one.

## 5. Discount types

| Type            | `value` means               | Effect                                                                                                                                                       |
| --------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `percentage`    | percent, 0 < v ≤ 100        | v% of the eligible lines' remaining amount                                                                                                                   |
| `fixed_amount`  | minor units, in `currency`  | That amount off the eligible lines, capped at what is left                                                                                                   |
| `buy_x_get_y`   | percent off the "get" items | Eligible units are sorted from most to least expensive. In every complete group of `buy_quantity + get_quantity`, the cheapest `get_quantity` are discounted |
| `free_shipping` | unused                      | Shipping becomes zero                                                                                                                                        |

## 6. Shipping and tax

**Shipping.** An address falls in every active zone listing its country, and whose regions (if any) include its region. A rate fits when:

- merchandise **after product discounts** is within the rate's subtotal band, so a discount can move a cart out of a "free over $75" band;
- the weight of the lines that ship is within its weight band.

**Tax** comes from a `TaxProvider`; the default reads `tax_rates`. A rate matches the address's country, and its region and postal prefix where the rate sets them. Of the matching rates, all of those with the highest `priority` apply, so a state rate and a county rate both apply, while a higher-priority district rate replaces them.

- **Exclusive rates** are charged on taxable lines after product discounts, and added to the total.
- **Inclusive rates** (such as UK VAT) are already inside the price. They are extracted and reported as `tax_included`, never added.
- **Shipping is not taxed.**

## 7. Rounding

Only two things multiply money by a rate: percentage-based discounts and tax. Each works out an exact `Decimal`, then converts it to minor units in one function, `round_minor`, **rounding half up, once per discount and once per tax rate, on the whole base**. Nothing is ever rounded per line and then summed.

Amounts that must be spread across lines (a discount's share, a tax rate's share) are split by `allocate`, using the largest-remainder method. Each line gets the floor of its proportional share, and the leftover minor units go to the largest remainders (the earliest line wins a tie). This is integer arithmetic, so the parts always sum exactly to the whole.

Example: 10% off three lines of $3.33. Rounding per line would give 33 + 33 + 33 = 99 cents. Velo rounds once, on $9.99, giving 100 cents, then splits it 34 / 33 / 33.

## 8. What the tests guarantee

Property-based tests (Hypothesis, `tests/unit/test_pricing_properties.py`) generate thousands of carts and check that, for every one:

- nothing is ever negative;
- a discount never exceeds what it discounts;
- line totals plus shipping equal the total, and subtotal − discount + shipping + tax equals the total;
- every tax amount is its exact value rounded once;
- the result does not depend on the order of lines or discounts;
- discounts never raise the merchandise total;
- allocation never loses or invents a cent, and each part is within one cent of its exact share.

The engine has 100% branch coverage. Every discount type and stacking combination has an example test in `tests/unit/test_pricing.py`.
