# State Initialization Contract

## Purpose and responsibilities

Construct the existing reference fixture and initial product state entirely in
memory. Initialization composes shared shapes; storage bootstrap, workspace
creation, schema migration and execution remain outside this module.

## Public API, inputs and outputs

- `createStateInitialization({ createMissionDomainState } = {})` requires a
  function and returns a frozen API containing the two methods below. Missing or
  non-function input throws `TypeError`.
- `createSeedState()` returns a fresh reference state with three historical
  Missions, the first active, fixture Knowledge/candidates, Agent profiles,
  capability registry and audit/runtime projections.
- `createProductState()` returns an initial product state with one ready Mission,
  idle Agent and Benchmark, required missing Baseline, empty candidate/Knowledge
  collections and no active current-best candidate. It first constructs the seed
  state, then replaces the product-specific fields.

The injected `createMissionDomainState(missionId, stage='diagnosis')` supplies
Mission defaults, including recovery paths. It must be an in-memory factory;
this module does not resolve or provision those paths itself. Both outputs retain
legacy initial `schemaVersion=7`, `stateVersion=0`, `commandJournalSeq=0` and
wall-clock `updatedAt`. These are initial values, not normalization of an incoming
snapshot; schema/version policy remains in `state-store.mjs`.

Example: `createStateInitialization({ createMissionDomainState }).createSeedState()`.

## Dependencies and side effects

Imports only reference data, Mission shapes, evidence shapes, objective/token
helpers and Mission intent. It consumes the injected Mission domain factory and
does not import `state-store`, storage/workspace adapters, queues or providers.
The only effects are allocating records and generating timestamp metadata; no
files, Git operations, processes, network requests, Agent or hardware runs occur.
Exceptions from the injected factory propagate.

## Invariants and known limitations

Returned state is mutable; freezing the API does not freeze its snapshots.
Fixture IDs, example results and illustrative tool records preserve compatibility
and cannot prove live hardware evidence. Product readiness is metadata, not a
completed preflight, frozen semantic approval, successful test or provisioned
Workspace. Neither constructor backfills Project registration or fully normalizes
its result; callers use the Mission domain normalization contract where required.
No new persisted format or Profile/test policy is introduced.

## Verification and changes

Run `npm run test:mission-project-state`, `npm run test:state-domain-boundary`,
`npm run test:state-storage-adapters` and `npm run test:state-store-projection`.
Update this contract, consumers and snapshot compatibility tests when defaults
change; keep bootstrap effects injected in their owning adapters.
