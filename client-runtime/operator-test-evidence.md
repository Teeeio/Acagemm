# Operator Test Evidence Projection Contract

Frozen tests require full queue request/Mission/purpose/candidate/source-run
identity even before raw projection. `settlePendingTestSnapshot` additionally
requires an exact terminal fingerprint, released resources and a verified current
workspace binding, then reuses the ordinary projection's Gate/failure branches.
It marks settlement once; later raw receipts cannot unset or duplicate it.

Canonical full snapshot content identifies an exact terminal replay. Equal
completion timestamps alone do not suppress changed results or release evidence.
Candidate projections retain `evidenceRunId` for identity-scoped presentation.

Projection retains the queue's submitted/submission/execution start timestamps
separately; missing values stay unknown and cannot inherit across requests. A
complete Benchmark observation, including execution-package binding and stage
timings, is queued for trace persistence before Baseline settlement clears the
display Benchmark slot. This observation does not produce a second verdict.

## Purpose

Project a queue snapshot into an already-loaded Runtime state. Gate evaluation
belongs to [Accept Gate](accept-gate.md); execution, persistence, repository
adoption and checkpoint restoration are caller-owned effects.

## Public API

- `applyOperatorTestSnapshot(state, snapshot)` mutates and returns the supplied
  state. A missing snapshot or mismatched `benchmark.testTaskId` is a no-op.
  Inputs use the existing queue DTO: task ID, status, progress/logs, result,
  timestamps, optional error and semantic binding.
- `isInfrastructureTestFailure(failure = {})` classifies existing connection,
  timeout and transport failure codes/messages. Explicit oracle/infrastructure
  categories, waiting deadlines and transport codes take precedence. Otherwise
  a runner-typed candidate exception stays a candidate failure regardless of its
  diagnostic text; only unclassified receipts use the legacy message fallback.
  TLS/SSL words in that fallback do not match embedded header names such as
  `HermeticPyObjectTLS.h`. Returns a boolean; no retry.
  Typed `OPERATOR_REFERENCE_CACHE_FAILURE` with `role=backend` is infrastructure:
  preserve the candidate and retest after repair, never spend candidate repair
  attempts. This does not reclassify a candidate's actual execution deadline.

## Outputs and invariants

Projection updates Benchmark/Baseline status and evidence, Candidate disposition,
failure records, decision review, Agent next action and in-memory events. Passed
managed-runtime evidence may create a Knowledge draft, not a published asset.

- Candidate attribution uses the applied Candidate/frozen Benchmark context;
  upstream submission/admission must establish workspace identity.
- Infrastructure failure must not become negative kernel evidence.
- Failed/cancelled Baseline status remains truthful.
- A Baseline whose scored reading did not settle is not a Baseline. Every later
  Candidate is judged as an improvement over that number, so recording one the
  runner itself reported as unrepeatable would anchor the Mission to a coin flip:
  the Baseline is left actionable to re-measure
  (`BASELINE_MEASUREMENT_UNSETTLED`, `baseline.measurement_unsettled`) instead of
  `complete`. The task did complete, so this is a retry, not a Mission failure.
- A matched terminal snapshot projects the actual executed target from
  `result.environment` into `state.iterationStats.resolvedTarget`, bound to the
  active Mission plus `sourceTaskId`/`sourceRunId` (payload `requestId` first).
  It is a distinct dimension from the backend/source name and is retained when a
  Baseline completion resets `benchmark`.
- Projection requires positive proof that the target was probed: a
  `targetProbe` carrying `deviceName`/`driverVersion`, or normalized
  `device`+`driverVersion`; a `completed` CPU result with `hardware=cpu` and
  `executionMode=cpu` is independently admissible. Hardware/architecture strings
  alone are not proof, so a shared-GPU preflight/cancelled result without a probe
  can neither fabricate nor clear an existing target (an existing `sm86` survives).
- Payload/evidence explicitly belonging to another Mission is never projected onto
  the active Mission, and a backend name (`local-shared-gpu`, `local-c500`, ...) is
  never accepted as projected hardware.
- Existing human-review requests stay blocking.
- Before replacing the target, projection compares the actual identity with the
  previous same-Mission target and explicit Mission constraints. Contradictions or
  newly undeclared dimensions remain in `resolvedTargetMismatch` and a bounded
  `resolvedTargetMismatches` history (10 entries); the actual evidence is unchanged.
  `isBackendTargetName(value)` and `extractEnvironmentTarget(environment,{status})`
  are public pure helpers used by round experience scope validation. Backend names
  are `local-shared-gpu`, `local-c500`, `local-c550`; legacy device labels such as
  `C550` are preserved as hardware declarations.
- Simulation evidence remains preview-only and non-publishable.
- Terminal transition handling and event deduplication retain existing behavior;
  this is not a generic idempotent event-sourcing API.

### Unified evidence decision projection

Gate evaluation still belongs to [Accept Gate](accept-gate.md), but production now
projects the one resulting decision as the single truth:

- The snapshot's explicit `remoteTaskId` is saved to `benchmark.remoteTaskId` for
  backend-task binding. The queue `testTaskId` is never written there. When a
  snapshot omits `remoteTaskId`, the previously recorded ID is retained only for
  the same request (matching `payload.requestId`, or `payload.runId` when request
  IDs are absent); a new request never inherits the previous run's backend ID.
- `gate.decision` is deep-cloned into `benchmark.evidenceDecision`, and
  `candidate.acceptGate.decision` plus `decisionReview.gate.decision` keep the same
  value. Consumers never re-derive a decision from `passed`/`publishable`.
- `ensureEvidenceKnowledgeDraft` classifies the draft only through
  `classifyEvidenceDecision`; the draft carries the decision clone, explicit
  `evidenceBinding` (candidateId/digest/runId), evidence level, publication state
  and non-publishable contraindications.
- A replayed terminal snapshot with the same canonical full content is a byte no-op:
  no new audit/runtime event, timestamp, candidate disposition or asset version.
- When `decision.adoption.status === 'waiting_external_verification'`, projection
  keeps the candidate and workspace, sets `decisionReview.status` to the resumable
  wait, records a `test.plan` resume action, sets `missionPaused = true` and
  `iterationStats.loopStatus = 'blocked'` with reason `external_verification`, and
  emits `accept_gate.waiting_external_verification` once per candidate/run.
  Re-entering the same wait is a no-op. No Agent is started to fetch missing
  diagnostics and no draft is created. Once a resumed retry produces a
  non-waiting decision, the stale blocked marker and resume acknowledgement are
  cleared without rewriting any evidence fact. Recovery reuses existing
  resume + retry of the same candidate with unchanged budget/release rules.
- `runAutomaticAdoption` keeps the Gate in review and copies the same decision into
  `currentBest.evidenceDecision`; real hardware and publication remain separate
  dimensions. A decision with `adoption.status !== 'allowed'` is not adopted.

## Dependencies and effects

Allowed: Gate, evidence factories, objective-independent identifiers, declarative
Agent capabilities, shared Runtime/audit events. No state-store, filesystem,
queue execution, provider or HTTP imports. Only the provided state changes;
event IDs/timestamps use the clock. Malformed caller data retains ordinary JS
errors; this module defines no persistence or network error contract.

## Compatibility and verification

The two original state-store exports alias these functions. New consumers use
this module; application services may also receive the functions as ports.

Run `npm run test:gate`, `npm run test:state-store-projection`,
`npm run test:loop`, and `npm run test:state-domain-boundary`.
Update projection tests, caller contracts and this document when DTOs or
dispositions change.

Snapshots may carry resourceRelease. An explicitly unconfirmed release can never
produce terminal/Gate evidence, even if the backend supplied a terminal label.
A later legacy terminal snapshot without release proof cannot erase an outstanding
unconfirmed test owner; it stays observable as running until proof arrives. Test
projection also preserves an independently unconfirmed/cancel-requested Agent's
identity and status, including when Baseline completes, so its owning provider can
still be reconciled. A test receipt never proves that the Agent has stopped.
Matching confirmed test resources reconcile the shutdown summary before Baseline
projection resets its task ID. Oracle failures and structured infrastructure,
environment or transport failures are not negative Candidate correctness evidence.
# Detached frozen tests

A Benchmark with `pendingManifestDigest` keeps its raw receipt in the existing
trace and updates the separate `pendingTest` lifecycle. Baseline projection retains
existing validation semantics. Candidate projection sets `decisionDeferred` before
success/failure decisions: it cannot grade, adopt or reject the current workspace
using a detached artifact's receipt. Terminal replay remains idempotent. The original
generation Agent record is preserved; a test receipt does not complete a new Agent.

## Completed generation identity across Baseline

When a released Agent already supplied the held candidate, Baseline completion or unsettled measurement preserves its runtimeKind only if candidate.sourceRunId matches the nonempty Agent runId. Otherwise the existing null runtime behavior remains. This preserves provider provenance needed by automatic repository adoption and source export; it does not launch an Agent, replace a resource receipt, or relax Gate/publication rules. tests/generic-runtime-safety-test.mjs covers matching and foreign candidate sources as well as unconfirmed owners.

The new backend selectors local-metax-c500/local-ascend910b are also excluded from observed hardware names. Only actual C500/Ascend910B device/driver-bearing environment records can attribute a resolved target.

C500 driver attribution reads the populated versions.driver field only after the exact development-accelerator core envelope is validated. Missing/foreign/unqualified probes never gain observed identity from a label.

For dedicated C500/910B source/service namespaces, observed-target projection requires the same pure live development protocol. CPU/simulation or contradictory namespace/probe fields return no observed accelerator target; generic legacy target projection is unchanged.
