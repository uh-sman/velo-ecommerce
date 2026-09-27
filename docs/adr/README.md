# Architecture Decision Records

Every significant technology and structural decision in Velo Commerce is recorded here as an ADR: the context that forced the decision, the options that were genuinely considered, the decision itself, and the consequences — including the bad ones.

**Why ADRs.** Six months from now the outcome will be obvious from the code; the _reasoning_ will not. An ADR is insurance against relitigating a settled decision, and against defending one that has quietly stopped making sense. Recording rejected options matters as much as recording the chosen one — "we considered Elasticsearch" is useless without "and here is why it lost".

## The index

| ADR                                        | Title                                          | Status   | Date       |
| ------------------------------------------ | ---------------------------------------------- | -------- | ---------- |
| [001](001-monorepo.md)                     | Monorepo over polyrepo                         | Accepted | 2026-09-20 |
| [002](002-postgresql-system-of-record.md)  | PostgreSQL as the system of record             | Accepted | 2026-09-20 |
| [003](003-fastapi-over-express.md)         | FastAPI as the API runtime                     | Accepted | 2026-09-20 |
| [004](004-modular-monolith.md)             | Layered modular monolith over microservices    | Accepted | 2026-09-20 |
| [005](005-money-as-integer-minor-units.md) | Money as `BIGINT` minor units                  | Accepted | 2026-09-20 |
| [006](006-payment-provider-abstraction.md) | Stripe behind a `PaymentProvider` interface    | Accepted | 2026-09-20 |
| [007](007-meilisearch.md)                  | Meilisearch for catalog search                 | Accepted | 2026-09-20 |
| [008](008-jwt-in-httponly-cookies.md)      | JWT in httpOnly cookies                        | Accepted | 2026-09-20 |
| [009](009-arq-over-celery.md)              | ARQ for background jobs                        | Accepted | 2026-09-20 |
| [010](010-webhook-confirmed-orders.md)     | Orders confirmed by webhook, never by redirect | Accepted | 2026-09-20 |

A one-line summary of all ten is in [`../ARCHITECTURE.md`](../ARCHITECTURE.md) §10. This directory is the long form.

## Statuses

| Status         | Meaning                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------- |
| **Proposed**   | Written, not yet agreed. Do not build against it.                                             |
| **Accepted**   | Agreed and in force. The codebase should reflect it.                                          |
| **Superseded** | Replaced by a later ADR, which is named in the header. The file stays — history is the point. |
| **Deprecated** | No longer in force and not replaced. Reason recorded in the file.                             |

## Rules

1. **One decision per ADR.** If the title needs "and", it is two ADRs.
2. **Never edit an accepted ADR's decision.** To change a decision, write a new ADR that supersedes it and update the old one's status header. The record of what we used to think is the value.
3. **Record the rejected options honestly**, including the ones that were close. An option listed only to be dismissed in half a sentence was not considered.
4. **State the consequences you do not like.** Every decision has them; an ADR listing only benefits is marketing.
5. **Give each ADR a "Revisit when" trigger** — the observable condition that should reopen it. A decision with no revisit condition becomes dogma.
6. **Number sequentially, never reuse.** Gaps are fine; collisions are not.

## Writing a new one

Copy [`000-template.md`](000-template.md) to `NNN-short-kebab-title.md`, fill it in, add a row to the index above, and raise it as a PR of its own so the decision gets reviewed as a decision rather than buried in an implementation diff.
