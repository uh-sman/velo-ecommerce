# ADR-NNN — <short imperative title>

|              |                                                             |
| ------------ | ----------------------------------------------------------- |
| **Status**   | Proposed \| Accepted \| Superseded by ADR-NNN \| Deprecated |
| **Date**     | YYYY-MM-DD                                                  |
| **Deciders** | <who agreed>                                                |
| **Related**  | ADR-NNN, ADR-NNN                                            |

---

## Context

What forces this decision now? State the problem, the constraints that are genuinely fixed (team size, budget, compliance, an existing commitment), and the thing that will go wrong if nobody decides. Facts, not preferences — preferences belong under Decision.

Name the constraint that eliminates most of the option space, if there is one. Usually there is.

## Options considered

| Option         | Summary  | Verdict                 |
| -------------- | -------- | ----------------------- |
| **A — <name>** | one line | ✅ Chosen / ❌ Rejected |
| **B — <name>** | one line | ❌ Rejected             |
| **C — <name>** | one line | ❌ Rejected             |

### A — <name>

What it is. What it would cost. Why it wins or loses. Give each option enough space that a reader can disagree with the conclusion on the evidence presented.

### B — <name>

Same, honestly. If an option was close, say it was close.

## Decision

**We will <decision>.**

One paragraph on the single reason that decided it. If there were three reasons, rank them — the first one is the real one.

## Consequences

**Good**

- What becomes easy or cheap.

**Bad**

- What becomes hard, slow, or expensive. **This section is mandatory and must be non-empty.**

**Neutral**

- What changes without being better or worse: new tooling to learn, a new dependency to track, a new failure mode to monitor.

## Revisit when

The observable condition that should reopen this decision. For example: "the catalog exceeds 500k variants", "a second team starts shipping independently", "the provider's regional coverage stops matching where customers are".
