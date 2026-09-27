# Page Specifications

> **Phase 2 deliverable.** Every screen in the storefront, the account area, and the admin dashboard — layout, mobile behaviour, states, and accessibility notes, specified closely enough that a developer can build any of them without asking a design question.
>
> **Product detail, checkout, and the cart drawer** are specified in [`DESIGN-SYSTEM.md`](DESIGN-SYSTEM.md) §5 and are not repeated here. Components referenced by name are specified in [`DESIGN-SYSTEM.md`](DESIGN-SYSTEM.md) §4; tokens in §2.
>
> **Last updated:** 2026-09-24.

---

## How to read these specs

Every page is specified as:

| Section           | What it fixes                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| **Job**           | The one thing this page exists to do. If a proposed element does not serve it, it does not belong. |
| **Layout**        | Desktop structure at `lg` and up, as a sketch.                                                     |
| **Mobile**        | What changes at base width. **Mobile is designed first**; the desktop layout is the expansion.     |
| **States**        | Empty, loading, error, and any page-specific ones. Not optional — see `DESIGN-SYSTEM.md` §4.       |
| **Accessibility** | Landmarks, heading order, focus behaviour, announcements.                                          |

**Rules that apply to every page in this document:**

- One `<h1>` per page, and the heading levels below it never skip.
- Every page has a `<main>` landmark and a skip link that lands on it.
- Loading states are shaped skeletons, not spinners. Images have reserved dimensions.
- Nothing that matters is behind hover alone.
- Every layout is verified at 320px, at 200% zoom, in light and dark.
- Touch targets are never below 44×44px.

---

# Part 1 — Storefront

## 1.1 Home

**Job:** get the shopper into a collection or onto a product in one interaction. A home page is a junction, not a destination.

### Layout

```
┌─────────────────────────────────────────────┐
│ Announcement bar (dismissible, optional)    │
│ Header: logo · nav · search · account · cart│
├─────────────────────────────────────────────┤
│  HERO                                       │
│  Headline · sub · [Shop the collection]     │
│  One image, one message, one action         │
├─────────────────────────────────────────────┤
│  Featured collections — 3 across            │
├─────────────────────────────────────────────┤
│  New arrivals — 4-col ProductCard grid      │
│  [View all →]                               │
├─────────────────────────────────────────────┤
│  Editorial block (image + copy + link)      │
├─────────────────────────────────────────────┤
│  Best sellers — 4-col grid                  │
├─────────────────────────────────────────────┤
│  Trust row: shipping · returns · support    │
├─────────────────────────────────────────────┤
│ Footer                                      │
└─────────────────────────────────────────────┘
```

- The hero is **one** image, **one** message, **one** primary action. No carousel: rotating heroes are ignored past the first slide, and they move content under the pointer.
- The hero image is `priority`, sized, and the LCP element. It is the page's entire performance budget in one asset — AVIF, under 150KB at 1280px wide.
- Product rows show 8 items maximum, then "View all". A home page is not a catalog.
- Blocks are ordered and toggled in admin; the order is data, not a deploy.

### Mobile

Hero at 4:5 with the headline below the image rather than over it — text over a photograph at 360px is either unreadable or an accessibility failure. Product rows become horizontally scrollable carousels, snapping, with the fourth card peeking so the scroll is discoverable. Collections stack full width.

### States

| State                 | Behaviour                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| Loading               | Hero skeleton at exact aspect ratio; product rows as card skeletons at the real column count      |
| Error (a block fails) | That block is omitted silently. **A failed "best sellers" query never takes the home page down.** |
| Empty catalog         | Hero plus a plain "Catalog coming soon" — only ever seen pre-launch                               |

### Accessibility

`<header>`, `<main>`, `<footer>` landmarks. `h1` is the hero headline; each block heading is `h2`. Carousels are scroll containers with visible focus, keyboard-scrollable, and are never auto-advancing. The announcement bar is dismissible and its dismissal persists.

---

## 1.2 Category / collection listing

**Job:** let a shopper narrow a catalog to the few things they want, without losing their place.

### Layout

```
┌──────────────────────────────────────────────┐
│ Breadcrumb: Home / Women / Dresses           │
│ H1 Dresses            128 products           │
│ Collection description (2 lines, expandable) │
├───────────┬──────────────────────────────────┤
│ FILTERS   │ [Sort: Featured ▾]               │
│ (sticky)  │ ┌──────┐┌──────┐┌──────┐┌──────┐ │
│ Price     │ │ Card ││ Card ││ Card ││ Card │ │
│ Size      │ └──────┘└──────┘└──────┘└──────┘ │
│ Colour    │ ┌──────┐┌──────┐┌──────┐┌──────┐ │
│ Brand     │ │ Card ││ Card ││ Card ││ Card │ │
│ In stock  │ └──────┘└──────┘└──────┘└──────┘ │
│           │        [Load more]               │
└───────────┴──────────────────────────────────┘
```

- **Filter state lives in the URL** (`?size=m&colour=black&sort=price_asc`). A filtered view must be shareable, bookmarkable, and survive the back button. This is the single most-missed requirement on listing pages.
- Facet counts are shown and update with the applied filters. A filter that leads to zero results is disabled, not offered.
- Applied filters appear as removable chips above the grid, with "Clear all".
- Filtering does not navigate: results update in place, the scroll position is kept, and the URL is replaced.
- Pagination is "Load more" plus infinite scroll, with a real paginated URL underneath for crawlers and for anyone who wants page 4.
- Sort options: Featured, Newest, Price ↑, Price ↓, Best selling. Default is Featured, which is operator-controlled.

### Mobile

Filters collapse into a bottom Sheet opened by a sticky "Filter (2)" bar showing the active count. Inside the sheet, filters apply on "Show 42 results" rather than instantly — applying under a covering sheet hides the effect and wastes requests. The grid is two columns at 360px; one column is a waste of a screen for cards this size.

### States

| State              | Behaviour                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| Loading            | 8 card skeletons at the real column count                                                                |
| Loading more       | 4 skeletons appended; the button becomes a spinner in place                                              |
| Empty (filters)    | "No products match these filters" plus the applied chips and "Clear all". **Never a bare "No results".** |
| Empty (collection) | "This collection is being restocked" plus a link to the parent category                                  |
| Error              | "We could not load these products" plus Retry; the filter rail stays usable                              |

### Accessibility

`h1` is the collection name. The grid is a `<ul>`. Result-count changes are announced via `aria-live="polite"` ("42 products"). Filter groups are `fieldset`/`legend`. "Load more" moves focus to the first newly-loaded card so the keyboard does not return to the top.

---

## 1.3 Cart page

The cart **drawer** is specified in `DESIGN-SYSTEM.md` §5. The cart _page_ is the full-screen version, reached from the header and from any link a customer shares with themselves.

**Job:** confirm what is being bought, allow last edits, and move to checkout without hesitation.

### Layout

```
┌────────────────────────────────┬──────────────┐
│ H1 Your cart (3 items)         │ ORDER SUMMARY│
│                                │ (sticky)     │
│ ┌────────────────────────────┐ │ Subtotal     │
│ │ CartLineItem               │ │ Discount     │
│ ├────────────────────────────┤ │ Shipping     │
│ │ CartLineItem               │ │ Tax          │
│ ├────────────────────────────┤ │ ──────────── │
│ │ CartLineItem               │ │ Total        │
│ └────────────────────────────┘ │              │
│ [Discount code    ] [Apply]    │ [Checkout →] │
│ Free shipping: $33 to go ▓▓▓░░ │ Express pay  │
│ ← Continue shopping            │ Trust row    │
├────────────────────────────────┴──────────────┤
│ You might also like — 4 ProductCards          │
└───────────────────────────────────────────────┘
```

- Shipping and tax read "Calculated at checkout" until an address exists. **Never `$0.00`** — a zero that becomes $9.00 two steps later is the classic abandonment trigger.
- The free-shipping progress bar appears only when a threshold is configured and unmet, and states the exact remaining amount.
- Price or availability changes since the item was added are shown inline on the affected line, with an explanation. Nothing changes silently.
- Express wallets sit directly under the checkout button — for customers who have them, the entire checkout is one tap.

### Mobile

Single column: lines, then discount, then a **sticky bottom bar** carrying the total and "Checkout". The summary collapses above the fold into one line — "Total $238.80 · view details" — expanding in place.

### States

| State            | Behaviour                                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Empty            | Illustration, "Your cart is empty", and two actions: "Shop new arrivals" and "View collections". Recently viewed below. |
| Loading          | Three line skeletons plus a summary skeleton                                                                            |
| Line updating    | That line dims to 60% with the stepper disabled; the summary shows a shimmer on the changed figures only                |
| Item unavailable | The line is marked, moved to a "No longer available" group below, and excluded from the total                           |
| Error            | Inline on the affected line with Retry. A failed quantity update never clears the cart.                                 |

### Accessibility

`h1` "Your cart". Lines are a `<ul>`. Quantity and removal changes announce via `aria-live="polite"` — "Quantity updated. Cart total $238.80". Removal focus moves to the next line, or to the empty-state action if the cart is now empty.

---

## 1.4 Order confirmation

**Job:** end the transaction with certainty. This page is read once, carefully, by someone who has just spent money.

### Layout

```
┌───────────────────────────────────────────┐
│              ✓                            │
│      Thank you, Ada                       │
│      Order #VC-10482 is confirmed         │
│      A receipt is on its way to           │
│      a***@example.com                     │
├───────────────────────────────────────────┤
│ What happens next                         │
│ 1 We pack your order    (1–2 days)        │
│ 2 It ships              (tracking by email)│
│ 3 It arrives            (est. 3 Oct)      │
├──────────────────────┬────────────────────┤
│ ITEMS                │ SUMMARY            │
│ line · line · line   │ totals as paid     │
├──────────────────────┴────────────────────┤
│ Delivery address    │ Payment  •••• 4242  │
├───────────────────────────────────────────┤
│ [Track this order]  [Continue shopping]   │
│ Questions? support@…  ·  Returns policy   │
└───────────────────────────────────────────┘
```

- **This page creates nothing.** It polls a read-only status endpoint until the webhook-created order exists (ADR-010).
- The order number is large, selectable, and the first thing after the confirmation line — it is what a customer quotes to support.
- "Track this order" works for guests via a signed link, with no account required.
- Totals are the amounts **actually captured**, read from the payment record, not recomputed.
- No upsell above the fold. A cross-sell row may appear below the fold, and never competes with the confirmation.

### Confirming state — the one that matters

While the webhook is in flight, the page shows a calm pending state, not a spinner over nothing:

> **Confirming your payment…** This takes a few seconds. Your payment has gone through — do not refresh or pay again.

Poll every 2s for 30s, then every 5s to 3 minutes, then: "Your payment succeeded and your order is being finalised. You will get an email within 15 minutes." — which is the reconciliation window (`PAYMENTS-AND-CHECKOUT.md` §7). **The customer is never told to retry a payment that succeeded**, and the page never implies failure for a delay that is ours.

### Mobile

Single column, generous vertical rhythm. The order number and "what happens next" fit on the first screen without scrolling.

### Accessibility

`h1` "Order confirmed". Focus moves to the `h1` on load. The confirmation is announced via `role="status"`. The state change from "confirming" to "confirmed" is announced. The success tick is decorative and carries no meaning alone — the text does.

---

# Part 2 — Account

Shared shell: a sidebar at `lg` and up (Orders · Addresses · Returns · Details · Sign out), a horizontal scrolling tab bar on mobile. The active item is `aria-current="page"`.

## 2.1 Sign in

**Job:** get a returning customer back in, and get everyone else past it.

- Centred card, max 400px. Email, password, "Forgot password?", "Sign in", then a divider and "Create an account".
- **Guest checkout is never behind this page.** If a customer arrives here from checkout, "Continue as guest" is the most prominent option on the screen.
- Errors are generic — "Email or password is incorrect" — never "no account with that email", which is an account-enumeration oracle.
- Rate limited after 5 attempts with an honest cooldown message, not a silent failure.
- `autocomplete="email"` and `autocomplete="current-password"`; the password field has a show/hide toggle with an accessible name.
- Post-sign-in redirect returns to the originating page, and the **guest cart merges into the account cart** with a toast saying so.

### States

Loading: the button locks its width and shows a spinner. Error: an alert above the form, focus moved to it. Locked out: the remaining time, and a password-reset link.

## 2.2 Create account

- Same shell. Email, password, optional name. Nothing else — every additional field costs conversions, and an address can be collected when it is needed.
- Password requirements are shown **before** typing, with live validation as it is typed, and a strength meter that is advisory rather than blocking.
- `autocomplete="new-password"`.
- Marketing opt-in is an **unchecked** checkbox with plain wording. Pre-ticked consent is not consent.
- Success signs the customer in directly and returns them to where they were.

## 2.3 Order history

**Job:** find one order fast.

```
┌────────────────────────────────────────────┐
│ H1 Orders          [Search] [Status ▾]     │
├────────────────────────────────────────────┤
│ #VC-10482 · 24 Sep 2026        [Delivered] │
│ 3 items · $238.80                          │
│ [img][img][img]     [View]  [Buy again]    │
├────────────────────────────────────────────┤
│ #VC-10310 · 2 Sep 2026          [Refunded] │
└────────────────────────────────────────────┘
```

- Newest first, 10 per page, cursor-paginated.
- Status badges use the same colours as admin — one vocabulary across the system.
- "Buy again" adds every still-available line to the cart and reports honestly what could not be added.

**Empty:** "No orders yet" plus a link to the catalog. **Loading:** three card skeletons. **Error:** retry, with the shell intact.

## 2.4 Order detail

The customer-facing mirror of the admin order page, with a timeline at the top.

```
Order #VC-10482                  [Delivered]
────────────────────────────────────────────
● Ordered 24 Sep  ● Paid 24 Sep
● Shipped 25 Sep  ● Delivered 27 Sep
────────────────────────────────────────────
ITEMS (per-shipment when partially fulfilled)
  Black Tee · L · ×2            $178.00  [Return]
  Canvas Bag                     $89.00  [Return]
────────────────────────────────────────────
SUMMARY   ·   DELIVERY ADDRESS   ·   PAYMENT
[Track shipment]  [Request a return]  [Invoice PDF]
```

- **Partial fulfilment is shown as it is**: items grouped by shipment, each with its own tracking. One combined status on a partially shipped order is a lie that generates a support ticket.
- Refunds appear on the timeline with the amount and date.
- Return controls appear per line, only while within the returns window and only for returnable items.
- Reachable by guests through a signed email link.

## 2.5 Addresses

- Card grid, 2-up at `lg`, stacked on mobile. Default address is badged.
- Add / edit open the AddressForm in a Dialog (a Sheet on mobile).
- Delete confirms in a Dialog naming the address. The default address cannot be deleted without choosing a new default first.
- **Empty:** "No saved addresses — they are saved automatically at checkout" plus "Add an address".

## 2.6 Returns

- List of return requests with status: Requested → Approved → In transit → Received → Refunded, plus Rejected with a stated reason.
- "Request a return" starts from an order: pick the lines, pick quantities, pick a reason from a fixed list, add an optional note.
- On approval the RMA number and return instructions are shown, with a label to print if one is issued.
- The refund line states the amount and the expected timeframe — "5–10 business days to your card" — because the next question is always "when?".
- **Stock does not return on RMA creation.** It returns on inspection (`DISCOVERY.md` §3.5).

---

# Part 3 — Admin

Shell: fixed left navigation (Dashboard · Orders · Products · Customers · Discounts · Settings), a top bar with search, environment badge, and user menu. Collapses to an icon rail at `md`, to a drawer below it. Admin is desktop-first — it is a working tool, not a shop window — but every page must remain usable on a phone for the urgent case.

## 3.1 Dashboard

**Job:** answer "is anything wrong, and what needs doing today?" in five seconds.

```
┌──────────────────────────────────────────────┐
│ Today ▾                          [Export]    │
├──────────┬──────────┬──────────┬─────────────┤
│ Revenue  │ Orders   │ AOV      │ Conversion  │
│ $4,820   │ 34       │ $141.76  │ 1.8%        │
│ ▲ 12%    │ ▲ 4      │ ▼ 2%     │ ▲ 0.2pt     │
├──────────┴──────────┴──────────┴─────────────┤
│ NEEDS ATTENTION                              │
│ ⚠ 3 orders paid, unfulfilled over 48h        │
│ ⚠ 2 payments failed today                    │
│ ⚠ 5 variants below low-stock threshold       │
├───────────────────────┬──────────────────────┤
│ Revenue, last 30 days │ Top products         │
├───────────────────────┴──────────────────────┤
│ Recent orders (10) — click through           │
└──────────────────────────────────────────────┘
```

- **"Needs attention" sits above the charts.** A dashboard that shows performance before problems is a report, not an operating tool. Each row links to a pre-filtered list.
- Every metric shows its comparison to the previous equivalent period, with direction conveyed by an arrow and a word, not by colour alone.
- Date range: Today, 7d, 30d, 90d, custom. The selection persists per operator.
- Charts have an accessible table alternative behind a "View as table" toggle.

**Empty (pre-launch):** zeros with "No orders yet", not blank panels. **Loading:** tile and chart skeletons at the real dimensions.

## 3.2 Product list

```
[Search        ] [Status ▾][Collection ▾][Stock ▾]   [+ New product]
┌─┬──────┬───────────────┬────────┬───────┬────────┬──────┐
│☐│ img  │ Name          │ Status │ Stock │ Price  │ ⋯    │
├─┼──────┼───────────────┼────────┼───────┼────────┼──────┤
│☐│ [ ]  │ Linen Shirt   │ Active │ 42    │ $89.00 │ ⋯    │
│☐│ [ ]  │ Canvas Bag    │ Draft  │ 0     │ $59.00 │ ⋯    │
└─┴──────┴───────────────┴────────┴───────┴────────┴──────┘
3 selected → [Activate] [Archive] [Edit price] [Export]
```

- Bulk selection with a visible action bar. Bulk operations report per-row outcomes — "42 updated, 2 failed" with the failures listed and retryable. A bulk action that reports only "done" is a bulk action nobody will trust twice.
- Stock is the sum across variants, with low-stock values badged `warning` and zero badged `danger`.
- Search hits name, SKU, and barcode; it reads Postgres, not the search index, because an operator who has just saved a product must find it immediately (ADR-007).
- Column visibility and sort persist per operator. 50 rows per page, cursor-paginated.
- Row click opens the editor; the `⋯` menu holds Duplicate, Archive, View in store, Delete.

**Empty:** "No products yet" with "Add your first product" and "Import CSV".

## 3.3 Product editor

Two columns at `xl`: content left, publishing and organisation right. Tabbed at `md` and below.

```
┌────────────────────────────────┬─────────────┐
│ Title                          │ STATUS      │
│ Description (rich text)        │ ○ Draft     │
│                                │ ● Active    │
│ MEDIA — drag to reorder        │ ○ Archived  │
│ [img][img][img][+]             │             │
│                                │ ORGANISATION│
│ PRICING                        │ Collections │
│ Price · Compare-at · Cost      │ Tags        │
│ Margin: 62% (computed)         │ Brand       │
│                                │             │
│ VARIANTS                       │ SEO         │
│ Options: Size, Colour          │ Title · Slug│
│ ┌──────┬─────┬──────┬────────┐ │ Meta · OG   │
│ │ S/Blk│ SKU │$89.00│ 12     │ │ Preview     │
│ │ M/Blk│ SKU │$89.00│ 8      │ │             │
│ └──────┴─────┴──────┴────────┘ │             │
│ SHIPPING — weight, dimensions  │             │
└────────────────────────────────┴─────────────┘
              [Discard]  [Save]
```

- **Variants generate from options** and are then editable inline as a grid — per-variant price, SKU, barcode, stock, image. Editing 24 variants through 24 modals is the difference between a usable admin and an abandoned one.
- Unsaved changes: the Save bar sticks to the bottom and a navigation guard warns before leaving.
- Media uploads are drag-and-drop with progress, reorderable by drag, with alt text on every image — **alt text is a required field**, since a store's product images are its content.
- Margin computes live from price and cost. Price changes warn when the product is in an active cart or discount.
- Slug auto-generates from the title and locks after first publish; changing it offers a redirect.
- Validation is inline and per-field, and the Save button reports the count of blocking errors rather than failing silently.

## 3.4 Order list

```
[Search        ] [Status ▾][Payment ▾][Fulfilment ▾][Date ▾]
┌──────────┬──────────┬──────────┬────────┬─────────┬───────┐
│ Order    │ Date     │ Customer │ Total  │ Payment │ Fulfil│
├──────────┼──────────┼──────────┼────────┼─────────┼───────┤
│ VC-10482 │ 24 Sep   │ Ada O.   │ $238.80│ Paid    │ Unful.│
└──────────┴──────────┴──────────┴────────┴─────────┴───────┘
```

- **Payment status and fulfilment status are separate columns.** Collapsing them into one "status" is the most common admin design error and it hides exactly the orders that need work — paid and unfulfilled.
- Default view is "Paid, unfulfilled, oldest first" — the work queue, not a chronological log.
- Saved views: Needs fulfilment · Unpaid · Refunded · Today. Filters live in the URL so a view can be shared.
- Bulk: mark fulfilled, print packing slips, export.
- A row for an order with a failed payment or an open dispute is flagged in the row itself, not only in a detail page nobody opens.

## 3.5 Order detail

**Job:** let an operator resolve anything about one order without a developer or a database.

```
Order VC-10482    [Paid] [Unfulfilled]     [⋯ More]
┌──────────────────────────────┬───────────────────┐
│ ITEMS                        │ CUSTOMER          │
│ ☐ Black Tee · L · ×2  $178.00│ Ada O. · 4 orders │
│ ☐ Canvas Bag · ×1      $89.00│ a***@example.com  │
│ [Fulfil selected]            │ ─────────────────  │
│                              │ DELIVERY ADDRESS   │
│ SUMMARY                      │ ─────────────────  │
│ Subtotal · Discount ·        │ PAYMENT            │
│ Shipping · Tax · Total       │ Visa •••• 4242     │
│ Paid $238.80 · Refunded $0   │ Intent pi_3O… ↗    │
│ [Refund]                     │ Captured 24 Sep    │
├──────────────────────────────┴───────────────────┤
│ TIMELINE (append-only)                           │
│ 24 Sep 14:02  Order placed                       │
│ 24 Sep 14:02  Payment captured  $238.80          │
│ 24 Sep 14:02  Confirmation email sent            │
│ 25 Sep 09:15  Note added by Tunde: "called"      │
├──────────────────────────────────────────────────┤
│ [Add note]  [Contact customer]                   │
└──────────────────────────────────────────────────┘
```

- **Partial fulfilment is first-class:** select lines and quantities, choose a carrier, enter tracking, and the customer is notified per shipment.
- **Refunds are per line item**, with the maximum refundable amount shown and enforced against the capture ledger. The confirmation dialog states the exact amount and that it cannot be undone. Restocking is an explicit checkbox, defaulted off — a returned item is not back in stock until someone has looked at it.
- The timeline is append-only and includes system events, emails sent, webhook events received, and operator notes with attribution. It is the audit trail, rendered.
- The payment section links out to the provider dashboard for the underlying intent.
- Cancelling an order before fulfilment offers a refund in the same flow rather than leaving two jobs half done.

## 3.6 Discount builder

**Job:** build a rule that behaves exactly as the operator expects, and show them what it will do before it is live.

```
┌──────────────────────────────────────────────┐
│ TYPE   ● Percentage ○ Fixed ○ Free shipping  │
│        ○ Buy X get Y                         │
│ VALUE  [ 20 ] %                              │
│ CODE   [SPRING20]  [Generate]  ○ Automatic   │
├──────────────────────────────────────────────┤
│ APPLIES TO                                   │
│ ○ Entire order ● Specific collections        │
│   [Dresses ×] [New in ×] [+ Add]             │
│ Minimum: ○ None ● Amount [$100] ○ Quantity   │
├──────────────────────────────────────────────┤
│ ELIGIBILITY                                  │
│ ● Everyone ○ Specific customers ○ First order│
├──────────────────────────────────────────────┤
│ USAGE LIMITS                                 │
│ ☑ Limit to [500] total uses                  │
│ ☑ One use per customer                       │
│ ☐ Combines with other discounts              │
├──────────────────────────────────────────────┤
│ ACTIVE  From [1 Oct 09:00] To [31 Oct 23:59] │
├──────────────────────────────────────────────┤
│ SUMMARY                                      │
│ "20% off Dresses and New in, over $100,      │
│  with code SPRING20, 500 uses, 1–31 Oct."    │
│ Example: a $150 cart of dresses pays $120.   │
│                     [Save as draft] [Activate]│
└──────────────────────────────────────────────┘
```

- The **plain-English summary and worked example update live** as the form changes. A discount rule that cannot be read back in a sentence will be misconfigured, and a misconfigured discount is money.
- Stacking behaviour is explicit, never implied. The default is "does not combine".
- Time windows are entered in the store's timezone, with the timezone labelled.
- Editing a live discount warns that carts already holding it are affected, and the summary diff is shown before saving.
- After launch, the detail view shows uses, revenue attributed, and AOV with and without — a discount nobody measures is a discount nobody should repeat.

---

## Mobile coverage

Every page above is specified mobile-first; this table is the checklist rather than a second design.

| Page                   | Base-width (320–639) behaviour                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| Home                   | Hero 4:5, text below image; product rows become snapping carousels                        |
| Collection             | 2-column grid; filters in a bottom Sheet, applied on "Show N results"                     |
| Product detail         | Per `DESIGN-SYSTEM.md` §5 — gallery swipe, sticky add-to-cart bar                         |
| Cart page              | Single column; sticky total + Checkout bar; summary collapsed to one line                 |
| Checkout               | Per `DESIGN-SYSTEM.md` §5 — one step per screen, summary collapsed at top                 |
| Confirmation           | Single column; order number and next steps above the fold                                 |
| Sign in / Register     | Full-width card, 16px minimum inputs to prevent iOS zoom                                  |
| Order history          | Cards rather than a table; status badge on its own line                                   |
| Order detail           | Stacked sections; timeline last; actions in a sticky bottom bar                           |
| Addresses              | Stacked cards; edit opens a Sheet                                                         |
| Returns                | Stacked cards; line selection as full-width checkboxes                                    |
| Admin — all            | Navigation as a drawer; **tables become card lists, never horizontally scrolling tables** |
| Admin — dashboard      | Metric tiles 2-up; "Needs attention" first; charts scroll horizontally                    |
| Admin — product editor | Tabbed (Content · Variants · Organisation · SEO); sticky Save bar                         |
| Admin — order detail   | Fulfil and Refund reachable without horizontal scrolling                                  |

**The admin rule is the one most often broken:** a data table squeezed onto a phone becomes a horizontally scrolling table that is unusable one-handed. Below `md`, every admin table renders as a list of cards with the two or three fields that matter.

---

## Outstanding

- [ ] Clickable prototype of the full checkout flow, walked end to end before any of it is coded (`PLANNING.md` 2.4). These specs are the input to it, not a substitute for it.
