# ADR-001 — Monorepo over polyrepo

|              |                  |
| ------------ | ---------------- |
| **Status**   | Accepted         |
| **Date**     | 2026-09-20       |
| **Deciders** | Project lead     |
| **Related**  | ADR-003, ADR-004 |

---

## Context

Velo Commerce ships four deployable or publishable units — a FastAPI service, a Next.js storefront, a Next.js admin dashboard, and a generated TypeScript API client — plus shared configuration. They are developed by one small team and released together.

The dominant constraint is **type coupling across the language boundary**. The API's OpenAPI schema generates the TypeScript client that both frontends consume (ADR-003). A change to a response shape must land in the backend, in the generated client, and in every frontend call site _in the same logical change_, or the frontends break against a backend that has already shipped.

The second constraint is team size. One team, one release cadence. The independent-deployment argument for polyrepos is answering a problem we do not have.

## Options considered

| Option                                  | Summary                                                     | Verdict     |
| --------------------------------------- | ----------------------------------------------------------- | ----------- |
| **A — Monorepo** (pnpm workspaces + uv) | One repository, one CI, workspace-linked packages           | ✅ Chosen   |
| **B — Polyrepo**                        | A repository per deployable, client published to a registry | ❌ Rejected |
| **C — Hybrid**                          | Frontends together, API separate                            | ❌ Rejected |

### A — Monorepo

pnpm workspaces manage the TypeScript side (`apps/storefront`, `apps/admin`, `packages/api-client`, `packages/config`); uv manages `apps/api`. Two package managers in one tree, which is honest about the fact that this is a two-language project.

A schema change is one commit and one PR: regenerate the client, fix the call sites, and CI type-checks the whole graph before merge. Breaking changes are caught at build time rather than in a customer's browser.

Cost: CI must be scoped so that a CSS change does not run the Python test suite. Solved with path filters, which is a known, bounded problem.

### B — Polyrepo

Each unit gets its own repository, and `@velo/api-client` is published to a registry. A response-shape change becomes: merge and release in the API repo → regenerate and publish the client → bump the dependency in two frontend repos → merge each.

That is four PRs across three repositories, with a window in the middle during which the published client does not describe the deployed API. For one team it is pure coordination overhead, and in practice the window is where the breakage lives. Rejected.

### C — Hybrid

Frontends and client together, API separate. Keeps the two frontends in sync but leaves the actual hard coupling — API ↔ client — split across repositories. It divides at the wrong seam: the language boundary is exactly where atomicity matters most. Rejected.

## Decision

**We will use a single monorepo**, with pnpm workspaces for TypeScript and uv for Python, laid out as `apps/`, `packages/`, `docs/`, `docker/`, `scripts/`.

The deciding reason is atomic cross-language changes. Second: one CI pipeline and one set of conventions to maintain. Third: a new contributor clones once and has the whole system.

## Consequences

**Good**

- A schema change and its consumers land in one reviewable commit.
- Generated types cannot drift from the API that generated them; CI fails if they try.
- Shared lint, format, and tsconfig live in `packages/config` and are consumed, not copied.
- One PR shows the full blast radius of a change, across both languages.

**Bad**

- CI must be path-filtered or every change pays for every test suite. Unfiltered, this gets slow by Phase 10.
- The repository has two package managers and two dependency lockfiles. Newcomers will run the wrong one at least once; `CONTRIBUTING.md` has to say so explicitly.
- Git history mixes concerns, so `git log` on the root is noisy. Scoped paths and Conventional Commit prefixes mitigate it.
- Repository-wide tooling (IDE indexing, `grep`) is slower than on a small repo.

**Neutral**

- Deployment stays independent regardless — each app builds its own image from the shared tree. Monorepo is a source-layout decision, not a deployment one.
- If the API is ever extracted (ADR-004 names the seams), the extraction is a directory move plus a CI split, not a rewrite.

## Revisit when

A second team begins shipping one of these apps on its own cadence, or CI wall-clock exceeds ~15 minutes on a typical PR after path filtering is already in place.
