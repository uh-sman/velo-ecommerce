# Contributing to Velo Commerce

This is a commerce system. A bug here does not produce a bad screenshot; it produces a wrong charge, an oversold item, or a customer who cannot complete an order. The conventions below exist to make that class of mistake harder.

---

## Getting set up

See [Getting started](README.md#getting-started) in the README. If a fresh clone does not reach a running stack in under ten minutes using only that section, **the README is the bug** — fix it in the same PR that surfaced it.

---

## Branches

```
<type>/<short-kebab-description>

feat/variant-selector
fix/cart-total-rounding
chore/bump-fastapi
docs/adr-011-rate-limiting
```

Branch from `main`. Keep branches short-lived — a branch older than a week is a merge conflict with a countdown.

`main` is always deployable. There is no `develop`.

---

## Commits

[Conventional Commits](https://www.conventionalcommits.org/). The format is enforced by a commit-msg hook.

```
<type>(<scope>): <subject>

[body]

[footer]
```

| Type       | For                                     |
| ---------- | --------------------------------------- |
| `feat`     | A user-visible capability               |
| `fix`      | A bug fix                               |
| `refactor` | Behaviour unchanged, structure improved |
| `perf`     | Faster, behaviour unchanged             |
| `test`     | Tests only                              |
| `docs`     | Documentation only                      |
| `chore`    | Tooling, dependencies, CI               |
| `build`    | Build system or Docker                  |

Scopes: `api`, `storefront`, `admin`, `client`, `db`, `infra`, `docs`.

```
feat(api): reserve inventory before creating a payment intent

Reservations carry a 15-minute TTL and are released by the sweeper.
Closes the race where two checkouts could both pass the stock check.

Refs: PLANNING.md 7.3, DISCOVERY.md R1
```

**Subject line:** imperative mood ("add", not "added"), no trailing period, under 72 characters. If you need "and", it is two commits.

---

## Pull requests

One logical change per PR. A PR that is easy to review is a PR that gets reviewed properly.

### Description template

```markdown
## What

One or two sentences. What changed, in plain language.

## Why

The problem, or the task reference (PLANNING.md 8.4, ADR-006, DISCOVERY.md R2).

## How

Only the non-obvious decisions. Do not narrate the diff.

## Testing

What you ran, and what a reviewer should run to disbelieve you.

## Risk

What could break, and how it rolls back.
```

### Review checklist

The author walks this before requesting review; the reviewer walks it before approving.

**Correctness**

- [ ] Every new behaviour has a test. **No test, no merge** — this is rule 2 of the task board.
- [ ] Error paths are tested, not only the happy path.
- [ ] Anything touching money uses the `Money` type in integer minor units (ADR-005). No floats. No `Decimal` on the wire.
- [ ] Anything touching inventory holds the row lock, or explains in the PR why it does not (DISCOVERY.md R1).
- [ ] Anything touching payments is idempotent and carries an idempotency key (R2).
- [ ] No new path creates a paid order outside the webhook handler (ADR-010).

**Structure**

- [ ] Layering holds: routers → services → repositories → models. A router that touches a repository fails the import lint, and the lint is not to be suppressed (ADR-004).
- [ ] Cross-module calls go through the other module's service, never its repository.
- [ ] No business logic in a route handler.

**Data**

- [ ] Migrations are expand/contract and have a tested down path.
- [ ] New queries have an index, and `EXPLAIN ANALYZE` output is in the PR if the query is on a hot path.
- [ ] No N+1 introduced — check the query count in the test.

**Security**

- [ ] No secret in the diff. gitleaks runs in pre-commit and in CI; do not bypass it.
- [ ] Input validated by a Pydantic model at the boundary.
- [ ] State-changing endpoints carry CSRF protection (ADR-008).
- [ ] No PII and no card data in any log line, span, or error report.

**Frontend**

- [ ] Keyboard reachable, with a visible focus ring.
- [ ] Contrast verified in light and dark.
- [ ] Empty, loading, and error states all exist (DESIGN-SYSTEM.md §4).
- [ ] Images have reserved dimensions — CLS is a build gate.
- [ ] No client-side price computation. The server states totals; the client renders them.

**Documentation**

- [ ] A significant decision has an ADR (`docs/adr/`), raised as its own PR.
- [ ] `PLANNING.md` checkboxes updated, honestly. A `[~]` with a note beats an `[x]` that is not true.

### Approval

One approval merges. Squash-merge; the PR title becomes the commit subject, so it follows the commit convention too.

**A PR that goes red in CI is the author's to fix, not the reviewer's to wait out.**

---

## Local checks

Run before pushing. Pre-commit runs the fast subset automatically.

```bash
# Python
cd apps/api
uv run ruff check . && uv run ruff format --check .
uv run mypy .
uv run pytest

# TypeScript
pnpm lint
pnpm typecheck
pnpm test
```

Pre-commit hooks: `ruff`, `ruff-format`, `mypy`, `eslint`, `prettier`, `gitleaks`.

```bash
pre-commit install && pre-commit install --hook-type commit-msg
```

**Never `--no-verify`.** If a hook is wrong, fix the hook in its own PR.

---

## Tests

| Kind        | Where                        | Runs against                                                                     |
| ----------- | ---------------------------- | -------------------------------------------------------------------------------- |
| Unit        | `apps/api/tests/unit`        | Nothing external. Pure logic: pricing, rounding, state transitions.              |
| Integration | `apps/api/tests/integration` | A real containerised Postgres and Redis. No mocked database.                     |
| Concurrency | `apps/api/tests/concurrency` | Real parallel transactions. The oversell and double-charge suites live here.     |
| Component   | `apps/*/src/**/*.test.tsx`   | Vitest plus Testing Library.                                                     |
| E2E         | `tests/e2e`                  | Playwright against a running stack, including axe-core accessibility assertions. |

Test names say what is guaranteed, not what is called:

```python
def test_two_concurrent_checkouts_for_the_last_unit_produce_one_order(): ...
```

Payment providers are substituted with the fake adapter (ADR-006). **No test ever calls a live payment API.**

---

## Dependencies

Adding one is a decision. Before you do: is it maintained, how large is it, what is its licence, and what does it pull in transitively?

- Python dependencies go in `apps/api/pyproject.toml`, resolved with `uv`. Commit the lockfile.
- Node dependencies go in the owning workspace package, never the root — except genuinely repo-wide tooling.
- A dependency that does one small thing we could write in twenty lines is usually not worth its supply-chain surface.

---

## Questions

If the answer is not in [`README.md`](README.md), [`PLANNING.md`](PLANNING.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), or [`docs/adr/`](docs/adr/), then the documentation has a gap. Open an issue for the gap as well as asking.
