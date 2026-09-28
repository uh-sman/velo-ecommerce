# Velo API

The FastAPI service. Python 3.12, managed by [uv](https://docs.astral.sh/uv/).

```bash
uv sync --all-groups          # install, including dev tooling
cp ../../.env.example .env    # then fill in
uv run uvicorn velo.main:app --reload
```

- API: <http://localhost:8000>
- Interactive docs: <http://localhost:8000/docs> (disabled in production)
- OpenAPI document: <http://localhost:8000/openapi.json>

## Layout

Layering is the rule the whole codebase depends on (`docs/ARCHITECTURE.md` §3). Dependencies point one way: **router → service → repository → models.**

```
velo/
├── main.py              app factory: lifespan, middleware, routers
├── core/
│   ├── config.py        typed settings; fails fast on a missing variable
│   ├── logging.py       structured JSON logs with a correlation ID
│   ├── errors.py        domain errors → RFC 9457 problem+json
│   └── middleware.py    correlation ID propagation
├── db/
│   ├── base.py          declarative base, naming convention, column mixins
│   ├── types.py         MinorUnits (money: BIGINT, refuses floats), Ltree
│   ├── ids.py           UUIDv7 primary keys
│   ├── models.py        imports every domain's models — the whole schema
│   ├── session.py       async engine, per-request sessions, session_scope()
│   └── redis.py         cache and counters — never a source of truth
├── api/
│   ├── health.py        /health (liveness), /ready (readiness)
│   └── v1/              versioned routers
├── domains/             one package per bounded context; each owns its models.py
│   ├── system/          repository + service; the walking-skeleton template
│   └── identity/ catalog/ inventory/ cart/ discounts/ shipping/ checkout/
│       orders/ payments/ platform/
└── scripts/
    └── seed.py          demo data: python -m velo.scripts.seed [--reset]
migrations/              Alembic: 0001 extensions + uuidv7(), then one per domain
```

Models never import another domain's models: a foreign key names the other table as a string (`ForeignKey("users.id")`), and there are no cross-domain relationships.

Rules worth restating, because they are the ones that erode:

1. A router never touches a repository or the ORM.
2. **A service never imports `fastapi`.** It raises domain errors; the handler decides the status code.
3. A repository holds no business rules.
4. ORM instances never escape the repository layer.

## Commands

```bash
uv run ruff check .            # lint
uv run ruff format .          # format
uv run mypy .                 # strict type check
uv run pytest                 # unit tests — no containers needed
VELO_RUN_INTEGRATION=1 uv run pytest -m integration   # needs `pnpm infra:up`

uv run alembic upgrade head                        # apply migrations
uv run alembic downgrade base                      # remove the whole schema
uv run alembic check                               # fails if the models and migrations differ
uv run alembic revision --autogenerate -m "add wishlists"   # then review it by hand
```

The integration suite wipes and migrates the `velo_test` database, never the development one.

## Errors

Every error leaves as `application/problem+json` (`docs/API-SPEC.md` §1), carrying the `request_id` that also appears in the `X-Request-ID` header and in every log line for that request.

```json
{
  "type": "https://velo.dev/errors/conflict",
  "title": "Conflict",
  "status": 409,
  "detail": "Only 2 units of SKU TSHIRT-NVY-L are available.",
  "instance": "/api/v1/cart/items",
  "request_id": "01JBQX7K3M9QZ8YW2N4P6R"
}
```

To add an error class, subclass `DomainError` with a distinct `slug` — a test asserts that no two share one, because a duplicated type URI silently breaks client branching.

## Health

| Endpoint      | Checks                        | Use                                      |
| ------------- | ----------------------------- | ---------------------------------------- |
| `GET /health` | Nothing. The process answers. | Liveness probe                           |
| `GET /ready`  | Postgres and Redis            | Readiness probe; 503 when either is down |

`/health` must never consult a dependency: a probe that fails on a Redis blip converts a degradation into an outage by killing healthy containers.
