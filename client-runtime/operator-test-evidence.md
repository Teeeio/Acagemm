# Operator Test Evidence Projection Contract

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
  timeout and transport failure codes/messages. Returns a boolean; no retry.

## Outputs and invariants

Projection updates Benchmark/Baseline status and evidence, Candidate disposition,
failure records, decision review, Agent next action and in-memory events. Passed
managed-runtime evidence may create a Knowledge draft, not a published asset.

- Candidate attribution uses the applied Candidate/frozen Benchmark context;
  upstream submission/admission must establish workspace identity.
- Infrastructure failure must not become negative kernel evidence.
- Failed/cancelled Baseline status remains truthful.
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
