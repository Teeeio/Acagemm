# Evidence Decision Contract

## Purpose and boundary

`evidence-decision.mjs` is the I/O-free, dependency-free shared contract for
diagnostic qualification and the versioned evidence decision. It owns no
workflow, storage, provider, queue or hardware behavior; it never mutates the
envelopes, bindings or state it reads. `accept-gate.mjs` consumes it and produces
the single decision object; consumers project flat Gate fields from that object
instead of re-deriving truth from a boolean.

## Public API

- `evaluateDiagnosticEvidence(kind, evidence, expectedBinding = {})` for
  `tracer | profiler`. Returns `{ schemaValid, available, evidenceEligible,
  reasons }`. The three predicates are independent:
  - `schemaValid`: the envelope has the documented format and field types.
  - `available`: a real collection actually completed. Only an explicit
    `completed` status counts; `ok`/`success`/`succeeded` are not completion and
    mock/simulated provenance always wins over a contradictory completed status.
    A missing or explicitly unknown source never proves availability, and a
    top-level `tool` name or artifact path may not backfill a missing
    `source`/`metricsSource`/`provenance`. Explicit simulation metadata is
    detected at any declared provenance location (`source`, `artifacts`,
    `metadata`, `provenance`, `metrics`, `metricsSource`, `metricsProvenance`)
    whether the container is an object or an array, so an array wrapper or
    nesting cannot hide a simulated/mock source.
  - `evidenceEligible`: the envelope is available, bound to the expected
    candidate/run identities, and its content satisfies the measurement rule.
- `projectDiagnosticBinding(evidence)`: pure extraction of the identity an
  envelope claims (`candidateDigest`, `runId`, backend `taskId`, `sourceRunId`,
  `semanticDigest`). It never reads queue task identities.
- `buildExpectedDiagnosticBinding(state)`: pure projection of the expected
  identity from `state.benchmark.candidate.digest` (or the applied candidate
  `patchDigest`), `state.benchmark.runId`, `state.benchmark.remoteTaskId`
  (backend task identity; the queue `testTaskId` is not a substitute),
  `candidate.sourceRunId` (falling back to the applied candidate record) and the
  frozen Mission `semanticDigest`. Unknown observations stay `null`. When the
  benchmark candidate and applied candidate disagree on id, digest or source run
  the projection reports `conflict: true` with `conflictReasons` instead of
  silently preferring one side.
- `classifyExecution(environment, result)`: returns `{ kind: 'live' |
  'simulation' | 'cpu' | 'unknown', liveHardware, source }`. Explicit
  simulation/mock/fixture/scripted and CPU signals are fail-closed and outrank a
  contradictory `liveHardware=true`; unmarked data stays `unknown` and is never
  publishable.
- `hasPublicationRestriction(environment)`: true for explicit development,
  shared-host, simulation/mock/fixture/scripted or CPU execution
  (`publishable:false`, `local-shared-gpu`, `shared-host-gpu`,
  `allowSharedHostGpu`, mock service/runtime names, etc.). Backend
  `publishable=true` is never required and never authorization.
- `classifyDiagnosticReasons(reasons)`: splits stable reason codes into
  `blocking` (malformed, fabricated or wrongly bound evidence) and `recoverable`
  (missing/unfinished real capability).
- Frozen constants: `EVIDENCE_DECISION_SCHEMA_VERSION`
  (`operator-studio.evidence-decision/v1`), `EVIDENCE_DECISION_POLICY_VERSION`,
  `DIAGNOSTIC_REASONS`, `DECISION_REASONS`.

## Content rules

Every supplied metric alias is checked; a valid alias cannot hide an invalid
second alias. Top-level metricsSource/provenance participates in metric-source
validation. Mock provenance in artifacts or metrics can veto eligibility but
cannot fill a missing source, and that veto is recursive over the declared
provenance containers above (objects or arrays). The scan is bounded by a
visited set and a depth cap, so cyclic or over-deep input cannot crash it. It
rejects metadata beyond the supported depth as invalid instead of skipping a
possible source restriction. A source explicitly declaring benchmark/latency
does not prove diagnostic collection. Missing profiler duration is recoverable;
a supplied invalid duration is malformed and blocking.

The scan
only honours explicit boolean markers and declared provenance-kind fields: raw
`path`/`name` values are never read, so an artifact path that merely contains
"mock" neither vetoes nor qualifies evidence. Unmarked liveHardware booleans
remain unknown; device-name substrings do not create a development restriction.

- Tracer: at least one event explicitly categorised `kernel`, named, with finite
  nonnegative `startUs` and finite positive `durationUs`. Runtime/tool events and
  events without a kernel category never qualify. Every kernel event must be
  well-formed: one invalid/unnamed/timeless kernel event fails the tracer and
  cannot be masked by another valid event. Missing measurements and
  string/NaN/Infinity/zero/negative values do not qualify.
- Profiler: finite positive `kernelDurationUs` from a real tool collection.
  Provenance is judged from an explicit `source`/`metricsSource`/`provenance`;
  a benchmark/latency metric source is explicit misuse. Durations are never
  rejected merely because a value equals a benchmark latency or tool duration
  (units differ and value equality proves nothing). Optional `occupancy`
  (`occupancy`/`occupancyRatio`/`achievedOccupancy`) must be finite in `[0,1]`;
  optional `bandwidth` (`bandwidth`/`bandwidthGBps`/`dramBandwidthGbps`) must be
  finite and nonnegative. Raw artifact paths prove no measurement content.
- Binding: a candidate digest or run mismatch, a source-run/backend-task
  mismatch, a missing expected semantic digest, or a contradictory
  benchmark/applied candidate projection is a blocking reason.

## Decision contract

`accept-gate.mjs` emits `decision` with schemaVersion
`operator-studio.evidence-decision/v1`, a fixed policyVersion and independently
inspectable fields: `binding`, `execution`, `correctness`, `benchmark`,
`diagnostics`, `adoption` and `publication`. Adoption status is one of
`allowed | reference | blocked | waiting_external_verification`; publication
status is one of `allowed | blocked | waiting_external_verification`. A malformed
benchmark core, failed correctness, an incomplete fixed-profile matrix, a
contradictory candidate binding or a failed frozen semantic binding blocks.
Missing required real diagnostics is tracked separately from a malformed core:
it pauses with `waiting_external_verification` (not a candidate hard error) and
still appears as a failed `evidence.complete`/`diagnostics.required` rule, so
format presence alone never reads as "evidence complete". Publication
additionally requires a passed adoption, live execution, no explicit
development/shared-host restriction and two eligible real diagnostics bound to
this candidate/run; backend `publishable=true` and service names are not
authorization.

## Verification

`npm run test:state-domain-boundary` checks this module stays inside the pure
domain graph (no storage/provider/application imports, no effectful builtins).
`npm run test:gate`, `npm run test:strict-zero-source` and
`npm run test:accept-gate-semantic-extreme` exercise Gate consumers. Reason codes
are stable contract; adding or renaming one requires updating this document and
the callers together.
