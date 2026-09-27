# ADR-005 — Money as `BIGINT` minor units with an ISO-4217 code

|              |                  |
| ------------ | ---------------- |
| **Status**   | Accepted         |
| **Date**     | 2026-09-20       |
| **Deciders** | Project lead     |
| **Related**  | ADR-002, ADR-006 |

---

## Context

Every price, line total, tax amount, shipping charge, discount, capture, and refund in the system is money. Money crosses four boundaries on its way to a customer: Postgres → Python → JSON → JavaScript. Each boundary is an opportunity to lose precision, and precision loss in money is not a rounding artefact, it is a financial discrepancy that eventually reaches an accountant.

The specific hazard is binary floating point. `0.1 + 0.2 != 0.3` in IEEE-754, in Python and in JavaScript alike. A cart that sums forty line items in floats will, reliably and unpredictably, disagree with the amount captured by the payment provider by a cent. That disagreement then fails the reconciliation check in `docs/PAYMENTS-AND-CHECKOUT.md` §7, which is working as designed but should never have been given the chance.

Payment providers have already settled this question: Stripe's API takes and returns integer minor units. Any representation we choose that is not integer minor units requires a conversion at the provider boundary — and conversions are where the cents go missing.

## Options considered

| Option                                       | Summary                       | Verdict              |
| -------------------------------------------- | ----------------------------- | -------------------- |
| **A — `BIGINT` minor units + currency code** | `1999` + `"USD"` = $19.99     | ✅ Chosen            |
| **B — `NUMERIC(12,2)`**                      | Exact decimal in the database | ❌ Rejected          |
| **C — `DOUBLE PRECISION`**                   | Float                         | ❌ Rejected outright |
| **D — Money as a string**                    | `"19.99"` everywhere          | ❌ Rejected          |

### A — `BIGINT` minor units

Every amount is stored as an integer count of the currency's smallest unit, paired with an ISO-4217 code on the owning row. Arithmetic is integer arithmetic: exact, associative, and identical in Postgres, Python, and JavaScript. `BIGINT` gives headroom of roughly ±92 quadrillion minor units, so overflow is not a practical concern.

It also matches the provider wire format exactly, so the payment boundary needs no conversion — the number we store is the number we send is the number that gets captured.

Formatting for display happens once, at the edge, via `Intl.NumberFormat`, which knows that JPY has no minor unit and KWD has three. The exponent is a property of the currency, not of our schema.

### B — `NUMERIC(12,2)`

Exact in Postgres and correct in isolation. It fails at the boundaries: Python maps it to `Decimal`, which has no JSON representation, so it is serialised either as a string (and every consumer must remember to parse it, forever) or as a float (and precision is lost at the last possible moment, silently). The hard-coded scale of 2 also bakes in an assumption that is wrong for JPY and KWD.

Close, but it optimises for correctness in one system while introducing a conversion at every edge. Rejected.

### C — `DOUBLE PRECISION`

Wrong. Not "risky" — wrong. Rejected without discussion, and named here so that nobody proposes it later believing it was overlooked.

### D — Strings

Avoids precision loss in transit, but every arithmetic operation needs a parse and every comparison needs care, so the type system stops helping exactly where it is most needed. Rejected.

## Decision

**All monetary values are stored and transported as `BIGINT` counts of the currency's minor unit, accompanied by an ISO-4217 currency code on the owning row.** A `Money` value object in Python and a matching TypeScript type wrap the pair; formatting happens only at the display edge.

The deciding reason is that integers are exact in every language the value passes through. Second: it is the payment provider's own representation, so the most dangerous boundary needs no conversion at all.

**Rounding rule:** where division is unavoidable — percentage discounts, tax on a line, splitting a shipping charge across items — round half-up to the minor unit at the _line_ level, then sum. Never sum then round, and never allow rounding remainder to vanish: the largest-remainder method distributes it so that the parts always sum to the whole. Documented with tests in `docs/DATA-MODEL.md` §1.

## Consequences

**Good**

- Arithmetic is exact everywhere; the float class of bug cannot occur.
- Our number and the provider's number are the same number.
- Reconciliation compares integers, so a discrepancy is a real discrepancy and never a representation artefact.
- Currencies with zero or three minor units are supported by construction rather than by special case.

**Bad**

- Every raw value needs mental division by 100 when reading the database by hand. `19_99` formatting in fixtures and a display view in admin queries take the edge off, but it stays a papercut.
- The `Money` wrapper must be used consistently; a raw `int` slipping into a calculation is the failure mode to guard against. Lint rules and typed columns catch most of it.
- Percentage discounts still require a documented rounding policy — integers remove precision loss, not the need to decide where a half-cent goes.

**Neutral**

- Multi-currency remains out of scope for v1 (`DISCOVERY.md` §4), but the currency code is stored from day one so that adding it later is a feature, not a migration of every money column.
- Analytics and exports divide at the presentation layer, like everything else.

## Revisit when

Never for the representation — this one is settled. The rounding policy gets revisited if a tax jurisdiction mandates a different rule (some require round-half-even, or rounding at the invoice level rather than the line level), in which case the policy becomes configurable while the storage stays exactly as it is.
