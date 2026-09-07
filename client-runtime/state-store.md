# State Store Access Contract

This is a compatibility/composition facade, not a pure domain import. All prior
public exports remain available; their domain implementations now live in
canonical modules. This file retains domain/initialization assembly, snapshot
schema/version policy, read/recovery coordination and delegated storage effects.
It does not implement Mission/Project or Knowledge transitions.

## Canonical ownership

- [Mission/Project state](mission-project-state.md): injected-path domain factory
  for normalization, projection, selection, CRUD and round state transitions.
- [Mission shapes](mission-state-shapes.md): budget, Research/Iteration/Agent records.
- [Knowledge state](knowledge-state.md): adoption and source-aware governance.
- [Reference data](state-reference-data.md), [initial state](state-initialization.md)
  and [reference projection](state-reference-runtime.md): retained default records,
  seed/product constructors and fixture progression, without storage/execution.

- [Accept Gate](accept-gate.md): evidence rules and Baseline evidence construction.
- [Operator Test evidence](operator-test-evidence.md): in-memory queue projection.
- [Evidence shapes](evidence-state.md), [Mission objective](mission-objective.md),
  [identifiers](state-identifiers.md) and [events](runtime-events.md): I/O-free contracts.
- [State Workspace](state-workspace.md): layout, fixture and checkpoint effects.
- [Snapshot storage](state-snapshot-storage.md): raw reads, atomic file writes,
  quarantine and injected bootstrap.

New domain consumers must use the canonical pure modules, not this facade.
Workspace initialization and seed/versioned persistence are injected into the
adapters here; the adapters do not import this module. The Mission/Project factory
receives the same root/workspace path values and path queries here and at the
production composition root. Application services receive explicit domain ports
and never import this facade. No state-schema migration is introduced.

Domain normalization precedes active-Mission projection and version increment on
save. Query reads normalize only in memory, with existing schema/version/sequence
compatibility fields; they never run fixture or Knowledge progression. Initial
snapshot factories retain their legacy schema constants, while incoming snapshot
migration/version policy remains here.

## Snapshot access

- `readState({ commandJournal?, applyRegistry? })`: reads an existing snapshot and
  normalizes its shape in memory. Journal inspection can project a transient
  recovery pause, but never replays, retries, acknowledges or writes anything.
  It does not initialize storage, ensure a Workspace, advance fixtures, adopt
  Candidates, or run Knowledge maintenance.
- Missing/corrupt/unreadable query snapshots fail with
  `STATE_SNAPSHOT_UNAVAILABLE`, `STATE_SNAPSHOT_CORRUPT`, or
  `STATE_SNAPSHOT_READ_FAILED`. A query never quarantines or replaces a file.
- `loadState({ ensureWorkspace?, commandJournal?, applyRegistry? })` is an
  **effectful initialization/recovery operation**, not a query. It retains
  storage compatibility migration, corrupt-snapshot recovery and journal replay.
  Runtime-mode policy and fixture advancement now live in
  `application/runtime-maintenance-service.mjs`.
- `saveState(state)` normalizes state, updates its timestamp/version and delegates
  atomic file replacement to the snapshot adapter. Serialization stays in State
  Repository; raw adapter writes do not normalize or increment versions.

All production access is injected through State Repository. HTTP/SSE reads select
`readState`; an explicit runtime advance selects `loadState` before running
the application pipeline. Pending recovery overlays are not saved by inspection.

## Reference projection

`refreshReferenceAgent(state)` and `refreshReferenceBenchmark(state)` expose the
existing fixture state transitions from `state-reference-runtime.mjs` for the
injected maintenance service. They
perform no persistence or external execution, retain their existing elapsed-time
semantics, and must only run for a validated reference-fixture context.

Verification: `test:state-store-projection`, `test:state-corruption-recovery`,
`test:runtime-read-isolation`, `test:command-recovery`,
`test:state-domain-boundary`, `test:state-storage-adapters`,
`test:mission-project-state`, `test:knowledge-state`.
