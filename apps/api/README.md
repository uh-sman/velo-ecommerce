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
│   ├── session.py       async engine and per-request sessions
│   └── redis.py         cache and counters — never a source of truth
├── api/
│   ├── health.py        /health (liveness), /ready (readiness)
│   └── v1/              versioned routers
└── domains/             one package per bounded context
    └── system/          repository + service; the walking-skeleton template
```

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
```

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
