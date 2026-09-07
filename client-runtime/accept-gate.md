# Accept Gate Contract

## Purpose and boundary

This domain module evaluates existing test evidence. It does not execute tests,
read storage, adopt a Candidate, or change the supplied state.

## Public API

- `evaluateAcceptGate(state, result = {})`: consumes the active Mission,
  Benchmark matrix, Baseline/current-best evidence and runner result. Returns
  `passed`, `publishable`, `result` (`eligible | reference | failed`),
  per-rule outcomes, summary and evaluation timestamp.
- `buildBaselineEvidence(state, result = {})`: projects runner measurements,
  shape/runner identity, source/materialization and semantic provenance into a
  Baseline evidence record. It does not mark the Baseline complete.

## Invariants

- Correctness, evidence completeness, frozen semantic binding, Baseline trust and
  comparability, and Mission performance policy retain their existing Gate rules.
- Fixed semantics and test matrices come from `fixed-operator-profiles.mjs`;
  this module must never invent smaller cases, shapes or retry budgets.
- C500 and C550 remain distinct identities.
- Mock/CPU/simulation results can exercise the workflow but are never publishable:
  `publishable` requires both a passed Gate and live-hardware provenance.
- Candidate/workspace identity is admitted upstream; this module does not inspect
  the filesystem or replace Candidate admission checks.
- A domain failure is represented by rule outcomes, not an execution retry.
  Required Mission/state shape is the normalized Runtime shape.

## Dependencies and effects

Only runner aliases, semantic contracts and evidence-state factories are allowed.
No persistence facade, filesystem, transport, provider or hardware implementations.
Inputs are not mutated. Evaluation timestamps use the system clock as before;
this is an I/O-free rule module, not a clock-independent function.

## Compatibility and verification

The old `state-store.evaluateAcceptGate` export aliases this implementation.
New consumers import this module directly.

Run `npm run test:gate`, `npm run test:accept-gate-semantic-extreme`,
`npm run test:strict-zero-source`, and `npm run test:state-domain-boundary`.
Change rule tests and this contract together; changing file ownership alone must
not change persisted evidence or eligibility.
