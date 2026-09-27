# ADR-003 — FastAPI as the API runtime

|              |                           |
| ------------ | ------------------------- |
| **Status**   | Accepted                  |
| **Date**     | 2026-09-20                |
| **Deciders** | Project lead              |
| **Related**  | ADR-001, ADR-004, ADR-009 |

---

## Context

The project was requested as a "PERN" stack (PostgreSQL, Express, React, Node) **built with FastAPI and Next.js**. Those two requirements are in direct conflict: PERN's E and N _are_ the API layer, and FastAPI _is_ the API layer. A system cannot have both without running two redundant backends, each with a claim on the database.

So this ADR resolves a contradiction in the brief, not merely a preference between frameworks. The resolution has to keep the intent of PERN — a relational Postgres core behind a React frontend — while honouring the explicit FastAPI requirement.

A secondary force: the API's contract must generate the frontend's types (ADR-001). Whatever runs the API must produce an OpenAPI document that is derived from the code rather than maintained beside it, because a hand-written schema is a schema that will eventually lie.

## Options considered

| Option                        | Summary                                                       | Verdict     |
| ----------------------------- | ------------------------------------------------------------- | ----------- |
| **A — FastAPI**               | Python 3.12, async, Pydantic v2, OpenAPI generated from types | ✅ Chosen   |
| **B — Express**               | Literal PERN; Node API tier                                   | ❌ Rejected |
| **C — Both**                  | Express BFF in front of FastAPI                               | ❌ Rejected |
| **D — Django REST Framework** | Batteries-included Python                                     | ❌ Rejected |

### A — FastAPI

Async-native, which matters because the checkout hot path is I/O-bound: database, Redis, Meilisearch, and a payment provider whose latency we do not control. Pydantic v2 gives one set of type definitions that serve as validation, serialisation, and the OpenAPI schema — so the generated TypeScript client cannot drift from what the server actually accepts and returns.

It satisfies the explicit requirement in the brief, and Node does not disappear from the stack: it renders Next.js.

### B — Express

Would make the acronym literal. It loses on the requirement — FastAPI was explicitly asked for — and on capability: request validation and OpenAPI are add-ons (zod plus a schema generator) rather than the framework's grain, and getting them to agree is ongoing work rather than a property of the system.

Rejected primarily because it contradicts the stated requirement. Recorded here because if Express endpoints are specifically needed, that is a materially different architecture and the plan would change; see the README's note on PERN.

### C — Both

An Express BFF proxying to FastAPI. Two runtimes, two deploy pipelines, two places for auth to be subtly different, and one more network hop in the checkout path — to satisfy an acronym. Next.js Route Handlers already cover every legitimate BFF need (cookie handling, server-side composition) without a second service. Rejected.

### D — Django REST Framework

Mature, with an admin that would save real time in Phase 11. But its ORM and middleware are sync at heart, async support is partial, and DRF serialisers are a second type system that does not feed a TypeScript generator cleanly. The free admin is a poor trade for a sync-shaped stack in an I/O-bound system. Rejected.

## Decision

**We will run the API on FastAPI (Python 3.12), served by Uvicorn, with Pydantic v2 models as the single source of truth for validation and the OpenAPI schema.** The resulting stack is PostgreSQL, FastAPI, React, Node — Node retained as the Next.js runtime.

The deciding reason is the explicit requirement. That it is also the better fit for an async, contract-first API is what makes the requirement easy to accept rather than merely obey.

## Consequences

**Good**

- One type definition per shape drives validation, serialisation, documentation, and the generated client.
- Async throughout suits a workload dominated by waiting on other systems.
- OpenAPI is generated from live code, so `docs/API-SPEC.md` describes something that exists.
- Python gives the reconciliation, reporting, and data-shaped work a natural home.

**Bad**

- The stack is bilingual. Contributors need both Python and TypeScript, and tooling must be maintained on both sides (Ruff and mypy; ESLint and tsc).
- "PERN" is now an approximation, which needs explaining to anyone who arrives expecting Express — hence the README section.
- Python is slower than Node at raw CPU-bound work. Irrelevant here (the hot path is I/O), but real if heavy in-process computation ever appears.
- No Django-style free admin; Phase 11 builds the dashboard by hand.

**Neutral**

- Background jobs must also be async-native to share service code without duplicating it — see ADR-009.
- Deployment is a container either way.

## Revisit when

The requirement changes and Express is genuinely needed, or a workload appears that is CPU-bound in the request path rather than I/O-bound.
