# Design System

The storefront has to be beautiful, obvious, and fast. Conversion is a design problem before it is an engineering one — every unnecessary field, every ambiguous label, and every 200ms of layout shift is measurable lost revenue.

---

## 1. Design principles

**1. The product is the interface.** Commerce UI exists to present merchandise. Chrome recedes; photography, price, and the buy button dominate. If a decorative element competes with a product image, it loses.

**2. Never make the customer guess.** Stock status, delivery date, return policy, and the final total are visible before commitment — not revealed at the last step. Surprise at checkout is the leading cause of abandonment.

**3. Reduce checkout to the legal minimum.** Every field is justified or deleted. No "confirm email". No forced account creation. No phone number unless the carrier requires it. Each removed field measurably raises completion.

**4. Every state is designed.** Loading, empty, error, partial, offline, and success. An undesigned state becomes a blank screen in front of a paying customer.

**5. Accessible by construction, not by audit.** Radix primitives, semantic HTML, real focus management. WCAG AA is a build-time gate, not a retrofit — and the same work that helps a screen-reader user helps everyone on a phone in sunlight.

**6. Fast is a feature.** Perceived performance beats actual performance: optimistic UI, skeletons matched to real content shape, images with reserved dimensions.

---

## 2. Tokens

Defined once as CSS custom properties, consumed by Tailwind. Never a hard-coded hex value in a component.

### Colour

Semantic names, not literal ones. `--color-danger`, never `--color-red` — the day danger becomes orange, a literal name becomes a lie.

```css
:root {
  /* Brand */
  --color-brand-50: #eef4ff;
  --color-brand-100: #d9e6ff;
  --color-brand-300: #8fb4ff;
  --color-brand-500: #2563eb; /* primary actions */
  --color-brand-600: #1d4ed8; /* hover */
  --color-brand-700: #1e40af; /* active */
  --color-brand-900: #1e3a8a;

  /* Neutrals */
  --color-neutral-0: #ffffff;
  --color-neutral-50: #f8fafc;
  --color-neutral-100: #f1f5f9;
  --color-neutral-200: #e2e8f0;
  --color-neutral-300: #cbd5e1;
  --color-neutral-400: #94a3b8;
  --color-neutral-500: #64748b;
  --color-neutral-600: #475569;
  --color-neutral-700: #334155;
  --color-neutral-800: #1e293b;
  --color-neutral-900: #0f172a;
  --color-neutral-950: #020617;

  /* Semantic */
  --color-success: #059669;
  --color-warning: #d97706;
  --color-danger: #dc2626;
  --color-info: #0284c7;
  --color-sale: #dc2626; /* sale pricing — deliberately the danger red */

  /* Surfaces — what components actually reference */
  --surface-page: var(--color-neutral-0);
  --surface-raised: var(--color-neutral-0);
  --surface-sunken: var(--color-neutral-50);
  --surface-overlay: var(--color-neutral-0);
  --surface-inverse: var(--color-neutral-900);

  --text-primary: var(--color-neutral-900);
  --text-secondary: var(--color-neutral-600);
  --text-tertiary: var(--color-neutral-500);
  --text-inverse: var(--color-neutral-0);
  --text-on-brand: #ffffff;

  --border-subtle: var(--color-neutral-200);
  --border-default: var(--color-neutral-300);
  --border-strong: var(--color-neutral-400);
  --border-focus: var(--color-brand-500);
}

/* Dark mode: system preference, unless the user has explicitly chosen light */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    /* dark values */
  }
}
/* Explicit user choice always wins */
:root[data-theme="dark"] {
  --surface-page: var(--color-neutral-950);
  --surface-raised: var(--color-neutral-900);
  --surface-sunken: var(--color-neutral-950);
  --surface-overlay: var(--color-neutral-800);

  --text-primary: var(--color-neutral-50);
  --text-secondary: var(--color-neutral-400);
  --text-tertiary: var(--color-neutral-500);

  --border-subtle: var(--color-neutral-800);
  --border-default: var(--color-neutral-700);
  --border-strong: var(--color-neutral-600);

  /* Brand lightens in dark mode — brand-500 on near-black fails AA */
  --color-brand-500: #60a5fa;
  --color-brand-600: #3b82f6;
}
```

**Dark mode is not an inversion.** Pure white on pure black causes halation and eye strain. Text tops out at `neutral-50`, surfaces bottom out at `neutral-950`, and the brand colour lightens so it still clears 4.5:1 against a dark surface. Every pair is verified, not assumed.

### Contrast verification

Every foreground/background combination is checked in both themes before it ships.

| Pair                               | Light  | Dark   | Requirement         |
| ---------------------------------- | ------ | ------ | ------------------- |
| `text-primary` on `surface-page`   | 17.9:1 | 16.1:1 | ≥ 4.5:1             |
| `text-secondary` on `surface-page` | 7.2:1  | 7.8:1  | ≥ 4.5:1             |
| `text-tertiary` on `surface-page`  | 4.8:1  | 5.1:1  | ≥ 4.5:1             |
| `text-on-brand` on `brand-500`     | 5.2:1  | 8.6:1  | ≥ 4.5:1             |
| `border-default` on `surface-page` | 3.1:1  | 3.4:1  | ≥ 3:1 (UI boundary) |
| `color-danger` on `surface-page`   | 4.6:1  | 5.9:1  | ≥ 4.5:1             |

A CI script parses the token file and fails the build on any pair below threshold. Contrast regressions are caught by the machine, not by a user filing a complaint.

### Typography

```css
:root {
  --font-sans: "Inter var", ui-sans-serif, system-ui, -apple-system, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;

  /* Fluid scale — clamp(min, preferred, max). No breakpoint jumps. */
  --text-xs: clamp(0.75rem, 0.73rem + 0.1vw, 0.8125rem);
  --text-sm: clamp(0.875rem, 0.85rem + 0.12vw, 0.9375rem);
  --text-base: clamp(1rem, 0.97rem + 0.15vw, 1.0625rem);
  --text-lg: clamp(1.125rem, 1.08rem + 0.22vw, 1.25rem);
  --text-xl: clamp(1.25rem, 1.18rem + 0.35vw, 1.5rem);
  --text-2xl: clamp(1.5rem, 1.38rem + 0.6vw, 1.875rem);
  --text-3xl: clamp(1.875rem, 1.68rem + 0.98vw, 2.5rem);
  --text-4xl: clamp(2.25rem, 1.93rem + 1.6vw, 3.5rem);

  --leading-tight: 1.15; /* headings */
  --leading-snug: 1.35; /* subheadings */
  --leading-normal: 1.55; /* body */
  --leading-relaxed: 1.7; /* long-form */

  --tracking-tight: -0.02em; /* large headings only */
  --tracking-normal: 0;
  --tracking-wide: 0.04em; /* small caps, labels */
}
```

Body text never goes below 16px on mobile — smaller triggers iOS Safari's auto-zoom on input focus, which is jarring mid-checkout.

Prices use tabular figures (`font-variant-numeric: tabular-nums`) so digits align in a column and totals do not jitter as quantities change.

### Spacing, radius, shadow, motion

```css
:root {
  /* 4px base — every gap is a multiple. Arbitrary values are a code-review failure. */
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-5: 1.25rem;
  --space-6: 1.5rem;
  --space-8: 2rem;
  --space-10: 2.5rem;
  --space-12: 3rem;
  --space-16: 4rem;
  --space-20: 5rem;
  --space-24: 6rem;

  --radius-sm: 0.25rem;
  --radius-md: 0.5rem;
  --radius-lg: 0.75rem;
  --radius-xl: 1rem;
  --radius-full: 9999px;

  --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
  --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
  --shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
  --shadow-xl: 0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1);

  --duration-instant: 100ms; /* hover, focus */
  --duration-fast: 150ms; /* buttons, toggles */
  --duration-normal: 250ms; /* drawers, dropdowns */
  --duration-slow: 400ms; /* page transitions */

  --ease-out: cubic-bezier(0.16, 1, 0.3, 1); /* entering — decelerate */
  --ease-in: cubic-bezier(0.7, 0, 0.84, 0); /* exiting — accelerate */
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1); /* playful, sparingly */
}
```

In dark mode, shadows barely read. Elevation there is conveyed by surface lightness instead — `surface-raised` sits above `surface-page` because it is lighter, not because it casts a shadow.

### Breakpoints

| Name  | Width   | Layout                                             |
| ----- | ------- | -------------------------------------------------- |
| base  | 320–639 | Single column, bottom-anchored actions, drawer nav |
| `sm`  | 640     | 2-column product grid                              |
| `md`  | 768     | 3-column grid, inline nav                          |
| `lg`  | 1024    | 4-column grid, filter sidebar, 2-column checkout   |
| `xl`  | 1280    | Max content width 1280px                           |
| `2xl` | 1536    | Wider gutters, content still capped                |

**Mobile-first, always.** Base styles target 320px; breakpoints add. Most storefront traffic is mobile, and a desktop-first design squeezed down is never as good as a mobile design allowed to expand.

---

## 3. Motion

| Interaction          | Duration             | Easing                 | Notes                                                       |
| -------------------- | -------------------- | ---------------------- | ----------------------------------------------------------- |
| Button hover         | 100ms                | `ease-out`             | Background and border only                                  |
| Button press         | 100ms                | `ease-out`             | `scale(0.98)`                                               |
| Focus ring           | instant              | —                      | **Never animated.** Keyboard users need immediate feedback. |
| Dropdown / popover   | 150ms                | `ease-out`             | Fade + 4px rise                                             |
| Modal                | 200ms                | `ease-out`             | Fade + `scale(0.96 → 1)`                                    |
| Drawer / sheet       | 250ms                | `ease-out`             | Slide from edge                                             |
| Cart badge increment | 400ms                | `ease-spring`          | The one place a spring is earned                            |
| Toast                | 200ms in / 150ms out | `ease-out` / `ease-in` | Slide + fade                                                |
| Skeleton shimmer     | 1.5s                 | `linear`, infinite     | Disabled under reduced motion                               |
| Page transition      | 250ms                | `ease-out`             | Fade only — no slide, which fights scroll restoration       |

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

Reduced motion means _reduced_, not _removed_: state changes still happen instantly and legibly, they simply do not animate. Vestibular disorders make parallax and large-scale movement genuinely nauseating — this is an accessibility requirement, not a preference.

---

## 4. Components

### Button

| Variant     | Use                          | Appearance                                      |
| ----------- | ---------------------------- | ----------------------------------------------- |
| `primary`   | The one main action per view | Brand fill, white text                          |
| `secondary` | Alternative action           | Neutral fill                                    |
| `outline`   | Tertiary                     | Border, transparent fill                        |
| `ghost`     | Low emphasis, toolbars       | No border, hover background                     |
| `danger`    | Destructive                  | Danger fill; destructive actions always confirm |
| `link`      | Inline                       | Underlined text                                 |

Sizes: `sm` 32px · `md` 40px · `lg` 48px · `xl` 56px.

**Required states:** default, hover, focus-visible, active, disabled, **loading**.

Loading state rules: the label is replaced by a spinner, the width is **locked to the pre-loading width** so the layout cannot shift, and the button is disabled. A checkout button that resizes mid-submit looks broken at the exact moment trust matters most.

Touch targets are never below 44×44px, including on dense mobile toolbars.

### PriceDisplay

```tsx
<PriceDisplay amount={8900} currency="USD" compareAt={11900} size="lg" />
// → $89.00  $119.00  −25%
//   ^bold   ^struck  ^sale badge
```

- Tabular figures so columns align
- Compare-at price struck through, in `text-tertiary`, with `<s>` for semantic meaning
- Discount percentage badge in `--color-sale`
- **Never** communicates the sale by colour alone — the strikethrough and the "−25%" text carry it for colour-blind users (WCAG 1.4.1)
- Formats via `Intl.NumberFormat`, which handles currencies whose minor unit is not 1/100

### VariantSelector

The highest-stakes component on a product page. A customer who cannot tell which size is available leaves.

| Availability            | Appearance                              | Behaviour                                          |
| ----------------------- | --------------------------------------- | -------------------------------------------------- |
| Available               | Normal, selectable                      | Selects                                            |
| Selected                | Brand border, filled                    | —                                                  |
| Out of stock            | Struck-through, dimmed, `aria-disabled` | Not selectable; label reads "Large — out of stock" |
| Unavailable combination | Dimmed                                  | Not selectable                                     |
| Low stock               | Normal + "Only 3 left"                  | Selects                                            |

Colour swatches carry `aria-label` with the colour name. A swatch that communicates only by hue is invisible to a colour-blind customer.

### QuantityStepper

- `−` and `+` buttons plus a direct numeric input
- `−` disabled at 1; `+` disabled at `max_quantity`
- Optimistic UI, debounced 300ms, rolled back on server rejection
- `inputMode="numeric"` so mobile shows the number pad
- Change announced to screen readers via `aria-live="polite"`

### Form fields

- Label **always visible above the input.** Placeholder-as-label disappears on focus, which strands anyone who was interrupted mid-form — and that is most people, most of the time.
- Placeholder shows format only: `MM / YY`
- Error text below the input, in `--color-danger`, with an icon — never colour alone
- `aria-invalid` and `aria-describedby` wired to the error
- Validate on blur, then on every change once an error exists. Validating on every keystroke from the first character means screaming "invalid email" at someone who has typed `j`.
- Correct `autocomplete` on every checkout field (`given-name`, `family-name`, `address-line1`, `postal-code`, `tel`, `email`). This alone can halve address-entry time.

### Select

Native `<select>` on mobile — the OS picker is better than anything we would build, and it is the control people already know. Custom listbox on `md` and up, where a styled menu is worth the cost.

| State           | Appearance                                                   |
| --------------- | ------------------------------------------------------------ |
| Default         | Same metrics as Input: 40px, `--radius-md`, `border-default` |
| Open            | `border-focus`, menu at `--shadow-lg`, 250ms `ease-out`      |
| Selected option | Brand tick on the left, `text-primary`                       |
| Disabled        | `surface-sunken`, `text-tertiary`, `cursor: not-allowed`     |
| Error           | `border-danger` plus the shared field error block            |

Custom listbox rules: `role="listbox"`, `aria-expanded`, `aria-activedescendant`; ↑/↓ move, Home/End jump, typing jumps to the first match, `Enter`/`Space` select, `Escape` closes and returns focus to the trigger. The menu never traps focus — it is a popover, not a dialog.

**Never a Select for fewer than three options.** Two options are radios; a yes/no is a checkbox.

### Checkbox and Radio

|               | Checkbox                                                | Radio                 |
| ------------- | ------------------------------------------------------- | --------------------- |
| Shape         | `--radius-sm` square                                    | `--radius-full`       |
| Size          | 20×20px visual, 44×44px hit area                        | same                  |
| Checked       | Brand fill, white tick                                  | Brand ring, brand dot |
| Indeterminate | Brand fill, white dash                                  | n/a                   |
| Disabled      | `surface-sunken`, `border-muted`, label `text-tertiary` | same                  |
| Error         | `border-danger` plus field error block                  | same                  |

- The **label is part of the target.** A 20px box that only responds to a 20px tap is a mobile failure; clicking the text toggles it.
- Never `appearance: none` without rebuilding the focus ring — a checkbox that cannot be seen when focused is a keyboard dead end.
- Radios are always in a `fieldset` with a `legend`. A radio group without an accessible group name is read as a stream of unrelated options.
- Checkbox groups allow zero selections; radio groups have exactly one, and one is pre-selected only when a default genuinely is the common case. On the shipping step, the cheapest method is pre-selected.

### Badge

| Variant   | Use                            | Colour                              |
| --------- | ------------------------------ | ----------------------------------- |
| `neutral` | Counts, metadata               | `surface-sunken` / `text-secondary` |
| `success` | Paid, delivered, in stock      | `success`                           |
| `warning` | Pending, low stock             | `warning`                           |
| `danger`  | Failed, refunded, out of stock | `danger`                            |
| `info`    | Processing, new                | `info`                              |
| `sale`    | Discount percentage            | `--color-sale`                      |

Sizes: `sm` 20px (inline with body text) · `md` 24px (table cells, cards).

**A badge always carries a word, never only a colour.** "Paid" in green, not a green dot — a status conveyed by hue alone fails WCAG 1.4.1 and is also simply unreadable to anyone who has not memorised the legend. Order-status badges use the same colour for the same status in admin and storefront, without exception.

### Card

The default container: `surface-raised`, `--radius-lg`, `--shadow-sm`, `--space-4` to `--space-6` padding.

- An **interactive** card (product, order) raises to `--shadow-md` on hover, shifts up 2px, and has a focus ring on the whole card.
- The whole card is one link, via a stretched pseudo-element over the title link, so there is exactly **one tab stop** per card. Ten separate links per product card makes keyboard browsing unusable and floods a screen reader.
- Nested interactive elements (a wishlist heart, a quick-add) sit above that overlay with their own `z-index` and their own accessible name.
- Cards never nest inside cards. If content needs a card inside a card, the layout is wrong.

### Dialog

Modal, for decisions that must be made now: confirm a deletion, confirm a refund, re-authenticate.

- Overlay `rgb(0 0 0 / 0.5)`, 200ms fade; panel fades and scales `0.96 → 1`.
- Max width 480px (confirm) or 640px (form); full-width minus `--space-4` gutters on mobile, anchored to the bottom.
- **Focus moves into the dialog on open, is trapped inside it, and returns to the trigger on close.** `Escape` closes; the overlay closes only non-destructive dialogs.
- `role="dialog"`, `aria-modal="true"`, `aria-labelledby` on the title, `aria-describedby` on the body. Background content is `inert`.
- Destructive confirmations name the object and the consequence — "Refund $89.00 to the customer? This cannot be undone" — and the destructive button is `danger`, never the default focus target.

**Dialogs are for decisions, not for content.** A dialog that scrolls should have been a page.

### Sheet

The same primitive as Dialog, anchored to an edge: 250ms slide, `ease-out`, same focus rules. Right edge on desktop (cart, filters, quick view), bottom edge on mobile with a drag handle and swipe-to-dismiss.

Widths: 400px (cart, filters) · 560px (quick view, admin detail panes). Full width below `sm`.

### Toast

Confirmation of something that already happened. Bottom-right on desktop, top on mobile — bottom-anchored toasts collide with thumbs and with the sticky add-to-cart bar.

| Variant   | Auto-dismiss                   |
| --------- | ------------------------------ |
| `success` | 4s                             |
| `info`    | 4s                             |
| `warning` | 6s                             |
| `error`   | **Never** — dismissed manually |

- Maximum three stacked; the oldest is dropped.
- Hovering or focusing pauses the timer. A toast that vanishes while it is being read is a toast that was never shown.
- `role="status"` `aria-live="polite"` for success and info; `role="alert"` `aria-live="assertive"` for errors.
- A toast is never the only place an error appears. Anything the customer must act on belongs in the page, near its cause.
- **Never** used for payment outcomes. That is a page state.

### Tooltip

Supplementary hints only — "Estimated delivery excludes weekends". Never essential information.

- 500ms hover delay before opening, instant on focus, 150ms fade, 4px rise.
- Touch devices have no hover, so **anything a tooltip says must be reachable another way**: an info button that opens a popover, or inline text.
- `aria-describedby`, never `aria-label` (which would replace the trigger's name rather than add to it).
- Never contains a link, a button, or anything the pointer must travel into.

### Skeleton

- Matches the real content's box exactly — same width, height, radius, and position — so nothing shifts when data arrives. A skeleton that is the wrong size is worse than none: it promises one layout and delivers another, which is a CLS failure with a friendly face.
- `surface-sunken` with a 1.5s shimmer; shimmer disabled under `prefers-reduced-motion`.
- Shown only after ~200ms of waiting. Flashing a skeleton for a 50ms response makes a fast page look broken.
- `aria-busy="true"` on the region, `aria-hidden` on the skeleton itself, and the real content announced when it lands.
- Product grids render skeletons at the real column count, so the grid does not reflow.

---

### ProductCard

The most-repeated component in the store; every flaw in it is multiplied by the grid.

```
┌──────────────────┐
│                  │  Image, 4:5, reserved dimensions
│      [♡]         │  Wishlist — top right, 44px target
│           [Sale] │  Badge — bottom left of image
├──────────────────┤
│ Brand            │  text-xs, text-tertiary
│ Product name     │  text-base, 2-line clamp
│ $89.00 $119.00   │  PriceDisplay
│ ●●●○ 4.2 (128)   │  RatingStars, optional
│ ● ● ● +2         │  Colour swatches, optional
└──────────────────┘
```

- **Image dimensions are always reserved** (`aspect-ratio` plus explicit width/height). The grid must not reflow as images load — this is the single largest CLS risk on the site.
- The name clamps to two lines; a card that grows with its title breaks the grid rhythm.
- One tab stop (see Card), with the wishlist button as a second, deliberate stop.
- Quick-add appears on hover at `md` and up only. On touch it is always visible or absent — never hover-dependent, because there is no hover.
- Out-of-stock cards stay visible, dimmed to 60%, with an "Out of stock" badge. Hiding them silently makes a catalog look thinner than it is and breaks returning links.
- Swatches show at most four plus a "+N"; clicking one swaps the image without navigating.

### StockIndicator

Stock is a trust surface. Over-promising here is what produces the apology email the whole system exists to avoid.

| Condition             | Display                    | Colour          |
| --------------------- | -------------------------- | --------------- |
| `> threshold`         | "In stock"                 | `success`       |
| `1 … threshold`       | "Only 3 left"              | `warning`       |
| `0`, restock expected | "Out of stock — notify me" | `danger`        |
| `0`, discontinued     | "No longer available"      | `text-tertiary` |
| Backorder allowed     | "Ships in 2–3 weeks"       | `info`          |

- The exact number appears only at or below the low-stock threshold (default 5). Showing "47 in stock" invites nothing; showing "Only 3 left" is honest urgency.
- **Never invent scarcity.** No countdowns, no "12 people are viewing this". The number shown is the number in the database.
- Icon plus text, never colour alone.
- `aria-live="polite"` so a variant change announces the new availability.

### RatingStars

- Read-only in the catalog; interactive only in the review form, where it is a radio group with a `fieldset`/`legend`.
- Half-stars render via a clipped overlay, never a rounded value — 4.2 shows as 4.2.
- Accessible name is the full sentence: "Rated 4.2 out of 5 from 128 reviews". A row of star glyphs read out individually is noise.
- The count is a link to the reviews section.
- **Zero reviews shows nothing at all** — not an empty five-star row, which reads as a one-star product at a glance.

### CartLineItem

```
┌────┬─────────────────────────┬──────────┐
│    │ Product name            │   $89.00 │
│ img│ Black · Large           │          │
│ 80 │ [− 2 +]        [Remove] │  $178.00 │
└────┴─────────────────────────┴──────────┘
```

- Image 80px in the drawer, 96px on the cart page; name links to the product.
- Variant summary is always visible. "Which size did I add?" must never require a click.
- Unit price and line total are both shown once quantity exceeds 1 — a single total invites "why is this $178?".
- Remove is a `ghost` button with an accessible name of "Remove Black Large T-shirt from cart", not "Remove". It is **undoable via a toast for 5 seconds**; a modal confirmation for removing a cart line is friction in the wrong place.
- Price changes since the item was added, and quantity clamped by stock, are shown inline on the line with an explanation — never silently applied, and never discovered at the payment step.
- Removal animates height to 0 over 250ms so the list does not jump.

### OrderSummary

The component customers scrutinise hardest. Every number must be explicable.

```
Subtotal (3 items)         $267.00
Discount (SPRING20)        −$53.40    [Remove]
Shipping — Standard          $9.00
Tax                         $16.20
─────────────────────────────────────
Total                      $238.80
```

- **Every line is itemised. No line is ever labelled "Fees".**
- Unknown values read "Calculated at checkout", never `$0.00` — a zero that later becomes $9.00 is the most common cause of abandonment at the final step.
- Discounts show the code and a remove control.
- Totals use tabular figures and are right-aligned so the column reads as a column.
- Sticky on desktop; on mobile, a collapsed summary bar at the top showing the total, expandable in place.
- The total is re-fetched from the server and re-rendered on every mutation. **The client never computes a total** — it renders one (ADR-005, and `docs/ARCHITECTURE.md` §5).

### AddressForm

Where most checkout time is spent, and most of it is avoidable.

- Field order follows the destination country's postal convention, not ours.
- Correct `autocomplete` on every field. This alone can halve entry time, and it is one attribute.
- Address autocomplete suggests after three characters, with a persistent "enter manually" escape — a customer whose address the API does not know must never be stuck.
- Country selection drives which fields appear: "State" and "ZIP" for the US, "County" and "Postcode" for the UK, and neither where they do not apply.
- Validate on blur; postal-code format is validated against the selected country.
- Saved addresses appear as selectable cards above the form, with "Use a different address" below.
- **Optional fields are labelled "(optional)".** Marking required fields with an asterisk means every field looks like a chore until it is decoded.
- Billing address defaults to the shipping address behind a checked checkbox; unchecking reveals a second form inline rather than navigating.

### StepIndicator

- Shows all four checkout steps, always visible, with the current one emphasised.
- Completed steps are links back; future steps are not — they are `aria-disabled`, since jumping ahead of a required step produces an error state that feels like a bug.
- `aria-current="step"` on the active step.
- Mobile shows "Step 2 of 4" plus the current step's name, with a progress bar. Four labels do not fit at 360px, and shrinking them to fit makes them unreadable.
- Completed steps collapse in the form body to a one-line summary with "Edit", so the page never scrolls past dead content.

---

### State matrix

Every interactive component implements every state that applies to it. A component is not done until this row is complete.

| Component          | Default |   Hover    | Focus-visible | Active |   Disabled   | Loading | Error | Selected |
| ------------------ | :-----: | :--------: | :-----------: | :----: | :----------: | :-----: | :---: | :------: |
| Button             |    ●    |     ●      |       ●       |   ●    |      ●       |    ●    |   —   |    —     |
| Input / Textarea   |    ●    |     ●      |       ●       |   —    |      ●       |    ●    |   ●   |    —     |
| Select             |    ●    |     ●      |       ●       |   ●    |      ●       |    ●    |   ●   |    ●     |
| Checkbox / Radio   |    ●    |     ●      |       ●       |   ●    |      ●       |    —    |   ●   |    ●     |
| Badge              |    ●    |     —      |       —       |   —    |      —       |    —    |   —   |    —     |
| Card (interactive) |    ●    |     ●      |       ●       |   ●    |      —       |    ●    |   ●   |    —     |
| Dialog / Sheet     |    ●    |     —      |   ● (trap)    |   —    |      —       |    ●    |   ●   |    —     |
| Toast              |    ●    | ● (pauses) |       ●       |   —    |      —       |    —    |   ●   |    —     |
| Tooltip            |    ●    |     ●      |       ●       |   —    |      —       |    —    |   —   |    —     |
| ProductCard        |    ●    |     ●      |       ●       |   ●    | ● (sold out) |    ●    |   ●   |    —     |
| VariantSelector    |    ●    |     ●      |       ●       |   ●    |      ●       |    ●    |   ●   |    ●     |
| QuantityStepper    |    ●    |     ●      |       ●       |   ●    |      ●       |    ●    |   ●   |    —     |
| CartLineItem       |    ●    |     ●      |       ●       |   —    |      ●       |    ●    |   ●   |    —     |
| StepIndicator      |    ●    |     ●      |       ●       |   —    |      ●       |    —    |   ●   |    ●     |

**Rules that apply to every row:**

- `focus-visible` is a 2px `--border-focus` ring at 2px offset. It is never removed, never animated, and never replaced by a colour change alone.
- Disabled controls are `aria-disabled` rather than `disabled` wherever the reason needs to be announced — a `disabled` button is skipped by screen readers, so the customer never learns why it cannot be used.
- Loading locks the element's dimensions. Nothing resizes while waiting.
- Error states are announced (`aria-live`), associated (`aria-describedby`), and phrased as what to do next.
- Every state is verified in light and dark, and at 200% zoom.

### Empty, loading, and error states

Every data-bearing component has all three.

| State       | Requirement                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Empty**   | Illustration, a sentence explaining what would appear here, and an action. "Your cart is empty — browse new arrivals →". Never a bare "No results." |
| **Loading** | A skeleton matching the real content's shape and size. A generic spinner causes layout shift when content arrives; a shaped skeleton does not.      |
| **Error**   | Plain language, the cause if known, and a retry. Never a status code. Never "Something went wrong" alone.                                           |

---

## 5. Key page specifications

The three highest-stakes screens are specified here. **Every other page** — home, collection listing, cart page, order confirmation, the account area, and the admin dashboard — is in [`PAGE-SPECS.md`](PAGE-SPECS.md), along with the mobile coverage checklist for all of them.

### Product detail

```
MOBILE (320–767)                    DESKTOP (1024+)
┌─────────────────────┐   ┌──────────────────┬──────────────────┐
│  ← back      ♡  ⋯   │   │                  │ Breadcrumb       │
├─────────────────────┤   │                  │ Brand            │
│                     │   │   Image gallery  │ Title        H1  │
│   Image (1:1.25)    │   │   sticky         │ ★★★★☆ 128        │
│   swipeable         │   │                  │                  │
│   ● ○ ○ ○           │   │   ┌──┬──┬──┬──┐  │ $89.00  $119.00  │
├─────────────────────┤   │   │  │  │  │  │  │ −25%             │
│ Brand               │   │   └──┴──┴──┴──┘  │                  │
│ Title           H1  │   │                  │ Colour: Navy     │
│ ★★★★☆ 128           │   │                  │ ◉ ○ ○ ○          │
│                     │   │                  │ Size  [guide]    │
│ $89.00  $119.00     │   │                  │ [S][M][L][X̶L̶]    │
│                     │   │                  │ ⚠ Only 3 left    │
│ Colour · Size       │   │                  │                  │
│ ◉ ○ ○   [S][M][L]   │   │                  │ [− 1 +]          │
│                     │   │                  │ ┌──────────────┐ │
│ Description ▾       │   │                  │ │ Add to cart  │ │
│ Specs ▾             │   │                  │ └──────────────┘ │
│ Shipping ▾          │   │                  │ ♡ Save           │
│ Reviews ▾           │   │                  │                  │
│                     │   │                  │ 🚚 Free over $50 │
│ You may also like   │   │                  │ ↩ 30-day returns │
│ ▸▸▸▸▸               │   │                  │                  │
├─────────────────────┤   │                  │ Description ▾    │
│ $89  [Add to cart]  │◀── sticky bar        │ Specs ▾          │
└─────────────────────┘                      └──────────────────┘
```

**Mobile has a sticky bottom bar with price and add-to-cart.** The buy action must never require scrolling back up. It appears once the inline button scrolls out of view.

### Checkout

Two columns on desktop: form left, order summary sticky right. Single column on mobile with a collapsible summary at the top.

```
Step 1  Contact      email · "or sign in" · guest is the default path
Step 2  Delivery     name, address (autocomplete), phone if needed
Step 3  Shipping     radio list: name, ETA, price
Step 4  Payment      express wallets first, then card element
        Review       final authoritative total, then [Pay $179.20]
```

**Rules:**

- The progress indicator shows all four steps and is always visible. Uncertainty about how much is left is itself a cause of abandonment.
- Completed steps collapse to a summary line with an "Edit" link.
- Express wallets (Apple Pay / Google Pay) appear **first** — they skip three steps entirely for the customers who have them.
- The order summary shows every component of the total. No line labelled "fees".
- The final button reads **"Pay $179.20"**, with the amount in it. Never a bare "Submit" or "Continue" at the point of payment.
- Trust signals near the button: secure-payment badge, return policy, support contact.
- **No field asks for anything not required to fulfil or bill the order.**

### Cart drawer

Slides from the right, 400px wide, full-width on mobile. Focus moves to the drawer on open, is trapped inside, and returns to the trigger on close. `Escape` closes. Each line has an image, title, variant, price, quantity stepper, and remove. Free-shipping progress bar when a threshold exists. Subtotal only — shipping and tax are unknown without an address, and inventing a number here breaks trust at checkout.

---

## 6. Accessibility requirements

**WCAG 2.1 Level AA. Gated in CI via axe-core in the Playwright suite. Zero violations merge.**

| Area               | Requirement                                                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Contrast**       | 4.5:1 body, 3:1 large text and UI boundaries, in both themes — verified by script                                                             |
| **Keyboard**       | Every interactive element reachable and operable. Logical tab order. Visible focus everywhere.                                                |
| **Focus**          | 2px ring, 2px offset, `--border-focus`. `:focus-visible`, so mouse users are not distracted. **Never `outline: none` without a replacement.** |
| **Focus trapping** | Modals and drawers trap focus; `Escape` closes; focus returns to the trigger                                                                  |
| **Screen readers** | Semantic HTML first, ARIA only where semantics fall short. Landmarks on every page.                                                           |
| **Images**         | Meaningful images have descriptive `alt`; decorative images have `alt=""`. Admin requires alt text on upload.                                 |
| **Forms**          | Every input has a `<label>`. Errors linked by `aria-describedby`, `aria-invalid` set.                                                         |
| **Live regions**   | Cart updates, filter results, and validation errors announced via `aria-live="polite"`                                                        |
| **Colour**         | Never the sole carrier of meaning — sale, stock, and error states all have text or an icon too                                                |
| **Motion**         | `prefers-reduced-motion` honoured throughout                                                                                                  |
| **Zoom**           | Usable at 200% zoom with no horizontal scroll and no clipped content                                                                          |
| **Touch**          | Targets ≥ 44×44px                                                                                                                             |
| **Skip link**      | "Skip to content" as the first focusable element                                                                                              |
| **Language**       | `<html lang>` set; page titles unique and descriptive                                                                                         |

**Manual testing, not just automated.** axe catches roughly a third of real issues. Before launch, every critical flow is walked with VoiceOver on iOS, NVDA on Windows, and with the keyboard alone. A checkout that passes axe but cannot be completed by a screen-reader user has failed.

---

## 7. Performance budgets

Enforced by Lighthouse CI; regressions fail the build.

| Metric                   | Budget       | Why                                                            |
| ------------------------ | ------------ | -------------------------------------------------------------- |
| LCP                      | < 2.0s       | Usually the hero or the product image                          |
| INP                      | < 200ms      | Add-to-cart must feel instant                                  |
| CLS                      | < 0.1        | Layout shift during checkout causes misclicks — and lost sales |
| TTFB                     | < 600ms      | Server render plus network                                     |
| JS bundle (initial)      | < 180KB gzip | Mid-range Android on 4G is the target device                   |
| CSS                      | < 30KB gzip  | Tailwind purges hard                                           |
| Image per product card   | < 60KB       | AVIF with a WebP fallback                                      |
| Lighthouse Performance   | ≥ 95         | Home, category, product                                        |
| Lighthouse Accessibility | 100          | Non-negotiable                                                 |

**Techniques:**

- Server Components for all static content — it never reaches the client bundle
- `next/image` with AVIF/WebP, responsive `srcset`, and **explicit width and height** to reserve space
- Blurhash placeholders so images fade in rather than pop
- Fonts preloaded and subset, `font-display: swap`
- Above-the-fold images `priority`; everything below lazy
- Payment provider script loaded only on the payment step
- Route-level code splitting; the admin bundle never reaches the storefront
- `preconnect` to the CDN and payment origins

**Test on a real mid-range Android over throttled 4G.** A design that only feels fast on a developer's laptop on office wifi has not been tested.
