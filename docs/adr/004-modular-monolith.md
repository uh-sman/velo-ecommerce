# ADR-004 — Layered modular monolith over microservices

|              |                  |
| ------------ | ---------------- |
| **Status**   | Accepted         |
| **Date**     | 2026-09-20       |
| **Deciders** | Project lead     |
| **Related**  | ADR-001, ADR-002 |

---

## Context

The API covers catalog, inventory, cart, pricing, checkout, payments, orders, fulfilment, returns, discounts, customers, and admin. A decomposition decision has to be made before Phase 3 lays down the directory structure, because retrofitting boundaries is expensive and removing them is worse.

Two forces dominate.

**First: the core workflow is transactional across domains.** Placing an order touches inventory, cart, pricing, payment, and order in one atomic write (ADR-002). Splitting those into services replaces a database transaction with a distributed one — sagas, compensating actions, and eventual consistency in exactly the place where the system has promised zero oversells and zero duplicate charges.

**Second: team size is one.** Microservices buy independent deployment by independent teams. With one team there is no independence to buy, only overhead to pay.

## Options considered

| Option                               | Summary                                             | Verdict              |
| ------------------------------------ | --------------------------------------------------- | -------------------- |
| **A — Layered modular monolith**     | One deployable, enforced internal module boundaries | ✅ Chosen            |
| **B — Microservices**                | Service per domain, network boundaries              | ❌ Rejected          |
| **C — Unstructured monolith**        | One deployable, no internal boundaries              | ❌ Rejected          |
| **D — Monolith + extracted workers** | Monolith plus separate job process                  | ✅ Partially adopted |

### A — Layered modular monolith

One FastAPI deployable, internally divided by domain module, with a strict layering rule enforced by import linting:

```
api/  →  services/  →  repositories/  →  models/
```

Routers handle HTTP and nothing else. Services own business rules and transaction boundaries. Repositories own queries. Models own persistence. A router that imports a repository directly, or a service that imports another module's repository, fails the lint — which is what makes "modular" a property of the build rather than of everyone's good intentions.

Cross-module access goes through the other module's _service_ interface, so today's function call is tomorrow's RPC call without touching the caller.

### B — Microservices

Would mean an inventory service, an order service, a payment service, and a catalog service, with the checkout flow coordinating across all four. The checkout transaction becomes a saga: reserve inventory (compensate on failure), create payment intent (compensate), create order (compensate). Every compensation is a code path that runs rarely, is hard to test, and fails in production first.

For the load in `DISCOVERY.md` §7.1 the scaling argument does not apply either — a single API process handles it with headroom. Rejected as paying a distributed-systems cost for a problem we do not have, in the one area where correctness matters most.

### C — Unstructured monolith

Faster for a week, then the routers query the database directly, the business rules live in three places, and extracting anything requires reading everything. Rejected — the structure is cheap now and unaffordable later.

### D — Monolith + extracted workers

The API process and the job process run the same codebase but different entry points (ADR-009), scaling independently. Adopted alongside A: it is a process-topology decision rather than a decomposition one, and it costs nothing because the code is shared.

## Decision

**We will build a layered modular monolith**, deployed as one API process plus a worker process group sharing one codebase, with module boundaries enforced by import-linting in CI.

The deciding reason is that the checkout must be one database transaction. Second: one team gains nothing from independent deployment. Third: boundaries drawn in the codebase can be promoted to network boundaries later, but a network boundary drawn too early cannot be cheaply undone.

## The extraction seams

Named now, so that a future split is a planned move rather than an archaeology project. Each is a module whose dependencies point inward and which could become a service without redesign:

| Seam                 | Why it could go first                             | What would have to change                                                  |
| -------------------- | ------------------------------------------------- | -------------------------------------------------------------------------- |
| **Search indexing**  | Already async, already derived from Postgres      | Nothing — it is effectively a service inside the process                   |
| **Media processing** | CPU-bound, spiky, no transactional coupling       | Nothing; already a worker                                                  |
| **Notifications**    | Fire-and-forget, no read path                     | Nothing; already a worker                                                  |
| **Catalog read API** | Read-only, cacheable, no writes in the hot path   | Read replica routing; cache invalidation moves to events                   |
| **Payments**         | Clean interface already (ADR-006), webhook-driven | Order creation becomes an event consumer — the expensive one; do this last |

**Inventory, cart, checkout, and orders do not have a seam between them and should not be given one.** They are one transaction.

## Consequences

**Good**

- Checkout stays a single ACID transaction; no sagas, no compensating actions.
- One thing to deploy, monitor, and debug. A stack trace crosses the whole flow.
- Local development is one process against docker-compose — the Phase 3 "under 10 minutes from clean clone" gate stays achievable.
- Refactoring across domains is a compiler-and-linter problem, not a coordinated multi-service release.

**Bad**

- The whole API scales as one unit: a traffic spike on catalog reads scales the payment code too. Wasteful, though cheap at this size.
- Module boundaries hold only while the lint holds. The day someone adds an exception "temporarily", the erosion starts — treat lint suppressions in import rules as review-blocking.
- A memory leak or crash in any module takes the whole API down; blast radius is the system.
- Deploys are all-or-nothing: a one-line catalog fix redeploys the payment code.

**Neutral**

- Workers already run separately, so the most bursty work is isolated without a service split.
- If extraction becomes necessary, the seams above are the order of operations.

## Revisit when

A second team needs to ship independently, one module's resource profile diverges sharply from the rest (sustained CPU or memory that forces over-provisioning of everything else), or deploy frequency is limited by cross-module risk rather than by CI time.
