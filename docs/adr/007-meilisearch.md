# ADR-007 — Meilisearch for catalog search

|              |              |
| ------------ | ------------ |
| **Status**   | Accepted     |
| **Date**     | 2026-09-20   |
| **Deciders** | Project lead |
| **Related**  | ADR-002      |

---

## Context

Search is a conversion feature, not a convenience one: shoppers who search convert at several times the rate of those who only browse, and a shopper who searches "adiddas" and gets nothing has been told the store does not stock the brand. Typo tolerance, synonyms, prefix matching as you type, and faceted filtering (price, size, colour, brand, availability) are therefore requirements, not enhancements.

The scale is modest — around 3,000 variants at launch and ~30,000 at twelve months (`DISCOVERY.md` §5) — which removes the distributed-search argument entirely. The real constraints are latency (search-as-you-type needs results under ~50 ms to feel instant), relevance quality out of the box, and operational cost for a small team.

Postgres remains the system of record (ADR-002); whatever we choose is a derived index that must be rebuildable from Postgres at any time, and never authoritative.

## Options considered

| Option                                            | Summary                                    | Verdict            |
| ------------------------------------------------- | ------------------------------------------ | ------------------ |
| **A — Meilisearch**                               | Purpose-built search engine, one container | ✅ Chosen          |
| **B — Elasticsearch / OpenSearch**                | Full-featured search platform              | ❌ Rejected        |
| **C — Postgres full-text search**                 | `tsvector` + `pg_trgm`, no new system      | ❌ Rejected        |
| **D — Hosted search** (Algolia / Typesense Cloud) | Managed, excellent relevance               | ❌ Rejected for v1 |

### A — Meilisearch

Typo tolerance, prefix search, faceting, synonyms, and custom ranking rules are defaults rather than configuration projects. A single container with modest memory covers our catalog size with sub-50 ms queries, and the tenant-token model lets the storefront query it directly where that is useful.

Relevance is good without tuning, which matters more than it sounds: a team of one will not run relevance experiments, so the out-of-the-box ranking is the ranking we ship.

### C — Postgres FTS

Genuinely attractive — one fewer system to operate, run, and back up, and it keeps search transactionally consistent with the catalog for free. It gets close: `pg_trgm` gives fuzzy matching, `tsvector` gives stemming, and faceting is `GROUP BY`.

It loses on the specifics that shoppers actually feel. Typo tolerance via trigram similarity is a blunt instrument compared with a real edit-distance ranker; relevance ranking needs hand-built weight expressions that require tuning nobody will do; multi-facet counts across a filtered result set turn into expensive aggregate queries on the primary — the same primary serving checkout; and prefix search-as-you-type over a growing catalog is where it degrades first.

Rejected, but it is the **documented fallback when Meilisearch is unavailable** (`DISCOVERY.md` §7.2: fail open on browsing). A degraded literal search beats an error page.

### B — Elasticsearch / OpenSearch

More capable than we need in every dimension, and the capability is the cost: JVM heap tuning, cluster management, index lifecycle policies, and a query DSL that is a skill in itself. Relevance requires analyzer configuration to reach what Meilisearch gives by default. Rejected as operational weight without a matching problem.

### D — Hosted search

Excellent products; Algolia's relevance in particular is better than anything we will configure ourselves. Rejected for v1 on two grounds: per-search pricing that scales with the traffic we are trying to attract, and a hard dependency on a third party for a core browsing path. Meilisearch Cloud remains the easy escape hatch if self-hosting becomes a burden — same engine, same API.

## Decision

**We will use Meilisearch as the catalog search index**, self-hosted as a container, populated asynchronously from Postgres, with Postgres full-text search as the documented degraded fallback.

The deciding reason is relevance quality per unit of operational effort: it gives typo tolerance and faceting at roughly the cost of running one more container. Second: the catalog size makes anything more powerful pure overhead.

**Indexing contract:** the index is derived, never authoritative. Writes go to Postgres and enqueue a reindex job (ADR-009); the index is eventually consistent by a few seconds, which is acceptable for browsing and is _not_ used for any stock or price decision at checkout. A full rebuild from Postgres is a single command and is exercised in CI so that it works on the day it is needed.

## Consequences

**Good**

- Typo tolerance, synonyms, and faceting work on day one without a relevance project.
- Sub-50 ms faceted queries at our catalog size, keeping search-as-you-type genuinely instant.
- Search load stays off the Postgres primary, which is also serving checkout.
- One container in docker-compose; local development has real search rather than a stub.

**Bad**

- A second datastore to run, monitor, back up (or rebuild), and upgrade.
- Eventual consistency: a just-published product is searchable seconds later, not immediately. Admin must not use search to verify a save — it reads Postgres.
- The index can silently drift from Postgres. Mitigated by a scheduled full reindex and a document-count reconciliation check, both alerting on divergence.
- Less powerful than Elasticsearch if complex aggregations or nested queries are ever needed.

**Neutral**

- Meilisearch Cloud is a drop-in replacement for the self-hosted container if operating it stops being worth the saving.
- Price and stock in the index are display hints only; the product page and cart always read authoritative values from Postgres.

## Revisit when

The catalog approaches ~500k variants, faceting needs more than about eight dimensions, relevance requires per-user personalisation, or operating the container costs more attention than hosted search would cost in fees.

## Implementation notes (Phase 6, 2026-09-28)

Recorded because each one was found by measurement, and each looks like something a later change might "tidy" away.

- **Searches are GET, on a fresh connection.** A POST goes out as two TCP segments; behind Docker's port relay (and some load balancers) the body waited for a delayed ACK on every reused connection — a flat ~45 ms. Meilisearch also writes small responses as two segments, which stalled ~7% of keep-alive searches on Linux by ~40 ms. GET removes the first; a fresh connection per search (quick-ACK mode) removes the second, for ~1.5 ms of handshake on a local network. `VELO_MEILISEARCH_SEARCH_KEEPALIVE=true` restores keep-alive where the engine is remote and the TLS handshake costs more than the stall.
- **A circuit breaker** opens for 15 s on any engine failure, so shoppers do not each wait out the timeout while Meilisearch is down; the first search after it expires probes again.
- **The Postgres fallback resolves the matching product ids once**, from product-level conditions, then pages and counts facets over that list. Recomputing the filtered listing inside each facet query took 49 s on 1,000 products; resolving once takes 40–70 ms.
- **The relay waits for Meilisearch to apply each batch** before marking its outbox events published, so a failed index task is retried rather than lost. While the engine is unreachable, index events are deferred — not failed, not dead-lettered — and drain when it returns.
- **A full rebuild** builds `products_build_<ts>` beside the live index and swaps them atomically, then re-syncs every product with an outbox event recorded during the build.

Measured on 1,000 products / 11,701 variants, API and client in Linux containers, one uvicorn worker: search p50 12 ms, p95 15 ms one request at a time (Meilisearch itself: 1 ms); p95 41 ms at 4 concurrent requests. With Meilisearch stopped: p50 39 ms, p95 62 ms, every response `degraded: true`, no errors.
