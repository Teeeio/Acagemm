# Workflow Kernel Contract

## Purpose

Own workflow outcome normalization, effect identity, recovery budgets and state
invariant collection. Pure and in-memory: no storage, Workspace, HTTP, provider or
Agent execution. It reconciles a state snapshot; callers own persistence.

## Public API

| Export | Output |
|---|---|
| `WORKFLOW_OUTCOME` | Frozen outcome kinds (`completed`/`in_progress`/`retryable_failure`/`terminal_failure`/`cancelled`) |
| `normalizeExternalOutcome(input)` | `{kind, terminal, retryable, error}` for an external status |
| `workflowEffectId({missionId, type, round, subject, revision})` | Stable `effect_<sha256>` identity |
| `consumeWorkflowRecoveryBudget(state, {component, limit})` | `{allowed, attempt, limit, component}`; mutates `workflowKernel.recoveryAttempts` |
| `deriveWorkflowEffect(state)` | Active effect or `null` |
| `collectWorkflowInvariantViolations(state)` | Violation list |
| `assertWorkflowInvariants(state)` | State or throws `WORKFLOW_INVARIANT_VIOLATION` |
| `reconcileWorkflowState(state, {now})` | `{state, changed, violations, effect}` |

## Invariants

`deriveWorkflowEffect` returns `null` while the Mission is paused or the loop is
`completed`/`needs_human`/`blocked`, so an `external_verification` wait cannot keep
an effect active.

`collectWorkflowInvariantViolations` emits `WORKFLOW_SIMULATION_PUBLISH_FORBIDDEN`
when a record claims publishable/verified evidence it is not entitled to. It is
decision-aware but legacy-preserving:

- With a unified decision, the canonical `benchmark.evidenceDecision` is preferred
  over the Gate's embedded copy; `gate.publishable === true` requires
  `decision.publication.status === 'allowed'` **and** `decision.execution.kind ===
  'live'`; `currentBest.verified === true` requires the publication to be allowed.
- A Gate `passed` flat flag that contradicts the unified decision's
  `adoption.status` emits `WORKFLOW_DECISION_GATE_MISMATCH`; only decision fields
  authorize, flat fields are the legacy projection.
- Without a decision, the previous live-hardware/`evidenceSource` boolean
  protection is retained. This still blocks old simulation pseudo-publication and
  never grants new authority.
- Other violations (`WORKFLOW_BENCHMARK_ORPHANED`, `WORKFLOW_BASELINE_REQUIRED`,
  `WORKFLOW_APPLIED_CANDIDATE_MISSING`, `WORKFLOW_CANDIDATE_EVIDENCE_MISMATCH`,
  `WORKFLOW_TERMINAL_EFFECT_ACTIVE`) are unchanged.

`reconcileWorkflowState` is idempotent for an unchanged snapshot: the same
violation fingerprint and status reuse the previous `reconciledAt` and `changed`
is false. Violations pause the Mission and set `needs_human` with a
`workflow_invariant:` reason; a recovered invariant block returns the loop to
`running`.

## Verification

`npm run test:workflow-kernel`, `npm run test:loop`,
`npm run test:workflow-commands`, `npm run test:state-domain-boundary`.
