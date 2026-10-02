# ADR-011 — Email templates rendered by the worker with Jinja2, not React Email

|              |                                  |
| ------------ | -------------------------------- |
| **Status**   | Accepted                         |
| **Date**     | 2026-10-02                       |
| **Deciders** | Project lead                     |
| **Related**  | ADR-004, ADR-009; PLANNING.md 12 |

---

## Context

PLANNING.md Phase 12 named React Email for the transactional templates: order confirmation, shipping, delivery, refund, password reset, email verification, welcome, back-in-stock, and the abandoned-cart sequence.

Every one of those emails is sent by the Python worker (ADR-009), from an outbox event, inside the async service layer (ADR-004). The template is the last step of a job that already holds the order, the customer and their preferences. React Email renders in Node. Using it means one of:

- a Node rendering service the worker calls per email — a second runtime and a network hop on the path of every receipt;
- or a build step that exports each React template to static HTML with placeholders for Python to fill — which works for flat fields but not for loops (order lines, refund lines): React cannot emit a template-language loop around table rows without invalid markup, so the lines would be pre-rendered strings, and the template would no longer be the whole email.

## Options considered

| Option                                             | Summary                                               | Verdict     |
| -------------------------------------------------- | ----------------------------------------------------- | ----------- |
| **A — Jinja2 templates in the API package**        | HTML and plain-text templates, rendered in the worker | ✅ Chosen   |
| **B — React Email, rendered by a Node service**    | The plan as written                                   | ❌ Rejected |
| **C — React Email exported to HTML at build time** | Static HTML with placeholders filled by Python        | ❌ Rejected |
| **D — The email provider's hosted templates**      | Templates edited in Resend; we send data              | ❌ Rejected |

**B** adds a runtime, a deployable and a failure mode to every email, for authoring comfort. **C** breaks on loops, as above, and leaves two sources of truth (the TSX and the exported HTML). **D** moves templates out of review and out of tests, and ties them to one provider.

## Decision

**Templates are Jinja2 files under `apps/api/velo/emails/templates/`**, an `.html` and a `.txt` for each email, both rendered from the same context, with autoescaping on for HTML. The HTML is written for email clients, not browsers: one 600 px table layout, inline styles only, no web fonts, no CSS the major clients drop. A development-only route renders every template with sample data, so they are reviewed in a browser without sending anything.

## Consequences

**Good**

- One runtime. The job that has the order renders the email it sends.
- Loops, conditionals and the plain-text alternative are first-class.
- Templates are tested like code: every template renders, in both forms, for every kind, in the unit suite.

**Bad**

- No component library: the shared header, footer and button are Jinja macros, and authoring email-safe HTML by hand is less pleasant than React Email's components.
- Rendering in Gmail, Outlook and Apple Mail is designed for, not proven: proving it needs a client-rendering service (Litmus or Email on Acid), which is not set up. That check is open in PLANNING.md 12.

## Revisit when

Marketing email (campaigns, newsletters) becomes a product: designers will want a visual builder, and a provider's template system (option D) or React Email (option B) becomes worth its cost for that kind of email — transactional email can stay here.
