# Accept Gate Contract

## Purpose and boundary

This domain module evaluates existing test evidence. It does not execute tests,
read storage, adopt a Candidate, or change the supplied state.

## Public API

- `evaluateAcceptGate(state, result = {})`: consumes the active Mission,
  Benchmark matrix, Baseline/current-best evidence, runner result and diagnostic
  envelopes. Returns flat `passed`, `publishable`, `evidenceSource`,
  `liveHardware`, `result` (`eligible | reference | failed`), per-rule outcomes,
  summary, evaluation timestamp and the single versioned `decision`.
- `decision`: schemaVersion `operator-studio.evidence-decision/v1`, a fixed
  policyVersion and inspectable `binding`, `execution`, `correctness`,
  `benchmark`, `diagnostics`, `adoption` and `publication` fields. Every flat
  field is a projection of this object.
- `buildBaselineEvidence(state, result = {})`: projects runner measurements,
  shape/runner identity, source/materialization and semantic provenance into a
  Baseline evidence record. It does not mark the Baseline complete.

## Invariants

- Correctness, evidence completeness, frozen semantic binding, Baseline trust and
  comparability, and Mission performance policy retain their existing Gate rules.
- Fixed semantics and test matrices come from `fixed-operator-profiles.mjs`;
  this module must never invent smaller cases, shapes or retry budgets.
- C500 and C550 remain distinct identities.
- Mock/CPU/simulation results can exercise the workflow but are never publishable.
  `publishable` is `decision.publication.status === 'allowed'`, which requires a
  passed adoption, live execution, no explicit development/shared-host
  restriction and two eligible real diagnostics bound to this candidate/run.
  A backend `publishable=true` is not sufficient authorization; a service name is
  never a whitelist. Explicit simulation/mock/fixture/scripted and CPU signals
  outrank a contradictory `liveHardware=true`.
- A result measurement is valid evidence only as a finite `number` greater than
  zero; `"-1us"` strings, booleans, NaN, Infinity and nonpositive values fail
  `evidence.complete` and `decision.benchmark.valid`. Only `currentBest` display
  parsing stays lenient.
- Local-adapter benchmark-core diagnostics are optional for adoption; explicit
  simulation/CPU paths keep their structured mock envelopes; other real paths
  require both diagnostics. Missing/unknown real diagnostic capability is
  recoverable (`waiting_external_verification`) and is tracked separately from a
  malformed benchmark core; malformed, mocked or wrongly bound evidence blocks.
  Format presence alone never reports "证据完整".
- A contradictory benchmark/applied candidate binding (id, digest or source run)
  blocks adoption and publication with `adoption.binding_conflict`.
- Candidate/workspace identity is admitted upstream; this module does not inspect
  the filesystem or replace Candidate admission checks.
- A domain failure is represented by rule outcomes, not an execution retry.
  Required Mission/state shape is the normalized Runtime shape.

## Dependencies and effects

Only runner aliases, semantic contracts, evidence-state factories and the pure
`evidence-decision.mjs` contract are allowed. No persistence facade, filesystem,
transport, provider or hardware implementations. Inputs are not mutated.
Evaluation timestamps use the system clock as before; this is an I/O-free rule
module, not a clock-independent function.

## Compatibility and verification

The old `state-store.evaluateAcceptGate` export aliases this implementation.
New consumers import this module directly and must preserve the same
decision/version rather than reclassify truth from `publishable`.

Run `npm run test:gate`, `npm run test:accept-gate-semantic-extreme`,
`npm run test:strict-zero-source`, and `npm run test:state-domain-boundary`.
Change rule tests and this contract together; changing file ownership alone must
not change persisted evidence or eligibility.

Legacy tests that assert `liveHardware`/backend liveness alone makes a result
publishable, that a mock execution reports the legacy `evidenceSource: 'mock'`
label instead of `simulation`, or that a local adapter without eligible real
diagnostics is publishable, are superseded by the frozen P2 evidence contract.
They must be replaced by an independent test task; they are not a valid
acceptance baseline for this decision layer. `tests/accept-gate-test.mjs`
currently fails on those superseded assertions and is expected to be replaced,
not weakened.
