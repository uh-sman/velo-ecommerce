# ADR-002 — PostgreSQL as the system of record

|              |                  |
| ------------ | ---------------- |
| **Status**   | Accepted         |
| **Date**     | 2026-09-20       |
| **Deciders** | Project lead     |
| **Related**  | ADR-005, ADR-007 |

---

## Context

Commerce is a set of multi-entity invariants that must hold simultaneously or not at all. Placing an order writes an order, its line items, a payment record, inventory movements, a reservation release, and a discount redemption. Either all of those land or none do. There is no acceptable middle state in which a customer is charged and no order exists, or stock is decremented for an order that was never created.

Alongside that, the system needs correctness guarantees under concurrency: two shoppers racing for the last unit must produce exactly one order and one honest refusal (`DISCOVERY.md` R1), which requires real row-level locking, not an application-level convention.

The catalog is also relational in shape — products to variants to option values to inventory to prices — and the reporting the operator needs (revenue, AOV, funnel, cohorts) is aggregation over that shape.

## Options considered

| Option                                          | Summary                                         | Verdict     |
| ----------------------------------------------- | ----------------------------------------------- | ----------- |
| **A — PostgreSQL 16**                           | Relational, ACID, strong constraints, row locks | ✅ Chosen   |
| **B — MongoDB**                                 | Document store, flexible schema                 | ❌ Rejected |
| **C — MySQL 8**                                 | Relational, ACID, widely deployed               | ❌ Rejected |
| **D — Postgres + a document store for catalog** | Split by workload                               | ❌ Rejected |

### A — PostgreSQL 16

Gives us, in one system: serialisable and read-committed transactions across every table in a checkout; `SELECT … FOR UPDATE` for the inventory race; `CHECK` constraints that make invariants unrepresentable rather than merely untested (`refunded_amount <= total_amount` cannot be violated by any code path, including a buggy one); partial and expression indexes; `JSONB` for the genuinely schemaless parts (provider payloads, product metadata) without giving up relational guarantees everywhere else; and window functions for the analytics the admin needs.

Operationally it is boring in the way infrastructure should be: PITR, logical replication, read replicas, and mature managed offerings (Neon, RDS, Aurora) with a clean upgrade path.

### B — MongoDB

Multi-document transactions exist but are the exception rather than the grain of the system, and they carry sharp operational caveats. More decisively, the invariants we care about — refunds never exceeding captures, fulfilled quantity never exceeding ordered — would move from database constraints into application code, which means they hold only as long as every code path remembers them. For a system whose entire pitch is being correct about money, that is the wrong trade. The schema flexibility on offer buys little: a product catalog is not schemaless, it is relational with a few variable attributes, and `JSONB` covers those. Rejected.

### C — MySQL 8

A credible option; genuinely closer than MongoDB. InnoDB gives ACID and row locks, and it would work. It loses on specifics we lean on repeatedly: weaker `JSONB` indexing, no partial or expression indexes with the same expressiveness, no transactional DDL (which matters for the expand/contract migrations in ADR-011 territory), a less capable planner for the analytical queries in admin, and no extension ecosystem equivalent to `pg_trgm` or `pg_stat_statements`. Rejected on capability, not correctness.

### D — Split stores

Postgres for orders, a document store for catalog. Two systems to operate, two consistency models, and a synchronisation problem between them — all to solve a catalog-read-performance problem we do not have at the sizes in `DISCOVERY.md` §5, and that Meilisearch (ADR-007) solves anyway without becoming a second source of truth. Rejected as premature.

## Decision

**We will use PostgreSQL 16 as the single system of record.** Every other datastore in the system — Redis, Meilisearch — is a derived cache or index that can be rebuilt from Postgres and is never authoritative.

The deciding reason is that commerce invariants belong in constraints, not in code review. Second: real row-level locking is what makes "zero oversells" a testable claim rather than an aspiration. Third: one database is one thing to back up, restore, and reason about.

## Consequences

**Good**

- Multi-table checkout writes are atomic by default, not by construction.
- Invariants are enforced by the database and therefore hold against every code path, including ones written under deadline pressure.
- The oversell guard is a documented, tested locking pattern rather than an application convention.
- Analytics query the live relational model — no ETL for launch-scale reporting.
- PITR and per-PR database branching (Neon) are available without extra machinery.

**Bad**

- A single primary is a single write bottleneck. Adequate for the load in `DISCOVERY.md` §7.1 with large headroom, but it is a ceiling and it should be named as one.
- Schema changes require migrations; expand/contract discipline is mandatory on every column change (Phase 4).
- Connection management needs care — async FastAPI plus a naive pool exhausts `max_connections` quickly. PgBouncer is on the Phase 17 path.
- Heavy analytical queries can contend with transactional traffic; they move to a read replica before they become a checkout problem.

**Neutral**

- Redis and Meilisearch remain in the stack as derived stores. Neither being authoritative is precisely what makes them safe to rebuild.
- Money representation is a separate decision, in ADR-005.

## Revisit when

Sustained write throughput approaches the flash-sale peak in `DISCOVERY.md` §7.1 (~2,000 orders/hour) with the primary saturated, or a workload appears that is genuinely not relational — event streams or time-series telemetry at volume — in which case it gets its own store rather than displacing this one.
