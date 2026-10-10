# Accept Gate Contract

Frozen reference digests, when declared, and submitted oracle/baseline digests are
checked by the existing semantic binding rule. A missing or changed declared
digest blocks adoption/publication. Legacy absent reference digests remain
explicitly unchecked; this repair never promotes historical evidence. Content
identity does not establish source authority or override shared-host restrictions.

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
  shape/runner identity, source/materialization, the scored reading's own
  `settled`/`settlements`, and semantic provenance into a Baseline evidence
  record. It does not mark the Baseline complete, and it does not itself refuse an
  unsettled reading — the caller that marks the Baseline complete does
  (`operator-test-evidence.md`), so the refusal cannot be bypassed by a caller
  that only reads the value.

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
- The scored reading must have settled (`benchmark[].settled`, written by the
  runner; see `tools/local-c500-runner.md`). An unsettled reading is refused in
  both directions: it is never adopted on a number that may be noise, and it is
  never reported as "no improvement" either. It keeps the Candidate as a weak
  reference with `adoption.measurement_unsettled` — deliberately not
  `adoption.performance_not_met`, which would turn "we could not decide" into
  "there was no gain" — and it is `not_measured` for progress against current
  best, so it cannot move or fail current best. A record that does not declare
  the field, and every backend that does not produce it, keeps the previous
  behaviour exactly; only an explicit `false` refuses. The
  `performance.settled` rule row reports it.
- Reaching a threshold admits the representation error of the arithmetic that
  produced it and nothing else: the threshold is
  `baseline * (1 - relativeTarget)`, so a candidate that meets the target lands a
  few parts in 1e8 off it. The allowance is 1e-6 relative, six orders below the
  timer's resolution on these readings, so a candidate that missed the target in
  any measurable way still misses it. Strict comparisons against current best are
  not given this allowance: a tie is not progress.
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
acceptance baseline for this decision layer. The current `tests/accept-gate-test.mjs` suite has passed the local CPU
verification and exercises the frozen decision contract; its passing result is
not live-hardware or publication acceptance.

Dedicated C500/910B results passing the pure development-accelerator protocol check use the existing local benchmark-core adoption path. Diagnostics remain unavailable/optional for adoption, with full correctness, benchmark, semantic/baseline and candidate binding rules unchanged. The check requires more than a service label; missing/foreign target probes fall back to the existing full live diagnostic requirements. Publication stays forbidden for these development namespaces.
