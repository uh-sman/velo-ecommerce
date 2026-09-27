# ADR-009 — ARQ for background jobs

|              |                           |
| ------------ | ------------------------- |
| **Status**   | Accepted                  |
| **Date**     | 2026-09-20                |
| **Deciders** | Project lead              |
| **Related**  | ADR-003, ADR-004, ADR-010 |

---

## Context

Work that must not happen inside a request: search reindexing, image derivative generation, transactional and marketing email, webhook event processing, the payment reconciliation sweep, the inventory reservation sweeper, and abandoned-cart recovery.

Two of these are load-bearing for correctness rather than merely for latency. **Webhook processing** must acknowledge the provider within a few hundred milliseconds and do the real work asynchronously, or Stripe's 20-second timeout triggers retries that arrive as duplicates while the first is still running (`docs/PAYMENTS-AND-CHECKOUT.md` §6). **Reconciliation** is the safety net that turns a lost webhook from a stranded payment into a 15-minute delay (`DISCOVERY.md` R3). Neither can be best-effort.

The constraint that decides it: these jobs call the same service layer as the API (ADR-004), and that service layer is async (ADR-003). A sync worker cannot call async services without either a duplicate sync implementation of every service or an event-loop bridge in every task — and a duplicated service layer is two places for a money bug to live.

## Options considered

| Option                            | Summary                                                   | Verdict                |
| --------------------------------- | --------------------------------------------------------- | ---------------------- |
| **A — ARQ**                       | Async-native job queue on Redis, from the pydantic author | ✅ Chosen              |
| **B — Celery**                    | The Python standard; mature, huge feature surface         | ❌ Rejected            |
| **C — FastAPI `BackgroundTasks`** | In-process, no broker                                     | ❌ Rejected            |
| **D — Dramatiq / RQ**             | Simpler Celery alternatives                               | ❌ Rejected            |
| **E — Postgres-backed queue**     | `SKIP LOCKED` on a jobs table                             | ❌ Rejected, but noted |

### A — ARQ

`async def` tasks that share the API's service layer, session management, and typing verbatim. Redis-backed, with retries and exponential backoff, cron-style scheduled jobs (which covers reconciliation and the reservation sweeper without a separate scheduler process), job results with a TTL, and graceful shutdown that lets in-flight jobs finish on deploy.

It is small — the whole thing is readable in an afternoon, which matters when a job fails at 2am and someone has to understand the queue rather than the documentation for the queue.

### B — Celery

The default answer, and it works. Against it: Celery is sync at heart. Async support exists but is peripheral rather than native, so tasks calling our async services need an event-loop bridge in each task — extra code in exactly the paths that handle money. Its configuration surface is enormous, and most of it (routing, chords, canvas workflows, multiple broker backends) addresses problems we do not have. It also brings a heavier operational footprint, plus Beat as a separate process for scheduling.

Rejected on the async mismatch. The maturity argument is real, but we would be paying for maturity in features we will not use, in return for friction in the ones we will.

### C — FastAPI `BackgroundTasks`

In-process, disappears on restart, no retries, no visibility, no scheduling, and it competes with request handling for the same event loop. Fine for fire-and-forget logging; unacceptable for webhook processing, where losing a task means losing an order. Rejected.

### D — Dramatiq / RQ

Both simpler than Celery and both sync-first, which reintroduces the exact mismatch that rules out Celery. Dramatiq is a good library; it is simply the wrong shape for an async codebase. Rejected.

### E — Postgres-backed queue

`SELECT … FOR UPDATE SKIP LOCKED` on a jobs table is a legitimate pattern: one fewer system, and job enqueue becomes transactional with the business write — which is genuinely attractive for the "enqueue only if the transaction commits" problem. Rejected because Redis is already in the stack for caching and reservations, because queue polling adds write load to the primary that serves checkout, and because ARQ provides scheduling and retries that we would otherwise hand-roll. Noted here because if Redis ever leaves the stack, this is the replacement, not Celery.

## Decision

**We will use ARQ for all background work**, running as a separate worker process group from the same codebase and image, with Redis as the broker. Scheduled jobs (reconciliation every 15 minutes, reservation sweeper every minute, nightly integrity checks) run as ARQ cron jobs.

The deciding reason is that tasks share the async service layer with no duplication and no bridging — one implementation of every money-moving operation. Second: built-in scheduling removes a separate scheduler process. Third: it is small enough to fully understand.

**Enqueue discipline:** jobs are enqueued _after_ the database transaction commits, never inside it. A job that starts before its data is visible is a race, and it is the kind that passes every test and fails under load.

## Consequences

**Good**

- One service layer, called identically from the API and from workers.
- Workers scale independently of the API (ADR-004's adopted process topology).
- Retries with backoff, and a dead-letter path for events that exhaust them — required by `DISCOVERY.md` R3.
- Cron jobs need no extra process, so reconciliation is one deployment concern rather than two.
- Graceful shutdown means a deploy does not abandon in-flight jobs.

**Bad**

- A smaller ecosystem than Celery: fewer integrations, fewer StackOverflow answers, a smaller maintainer pool. A bus-factor dependency, accepted knowingly.
- No mature web dashboard equivalent to Flower; queue depth and failure rate go to the metrics stack instead (Phase 16), which is where they belong anyway but is more work.
- Redis becomes a hard dependency for background work. It fails open for caching but not for queueing — a Redis outage stops job processing, and webhook events then rely on the reconciliation sweep to catch up once it returns.
- Enqueue-after-commit is a discipline, not an enforced property. It needs a review checklist item and a test.

**Neutral**

- Job payloads must be JSON-serialisable, so tasks take IDs and re-fetch, which is the right pattern regardless.
- Idempotency is required of every job, since retries are expected rather than exceptional.

## Revisit when

Job volume outgrows a single Redis instance, a workflow needs genuine DAG orchestration (chained tasks with fan-in), or ARQ's maintenance stalls — at which point Postgres `SKIP LOCKED` (option E) is the first alternative to evaluate, not Celery.
