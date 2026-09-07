# Command Journal Contract

The command journal coordinates durable intent, external effects, deterministic state
application, and recovery. Callers hold the State Repository exclusive lock and pass
a fresh state snapshot. It does not select providers, execute hardware, or decide Gate
outcomes.

## Command protocol

- `keyFor(state, body)` identifies a logical command; `isApplied(state, payload)` checks
  whether a completed command still describes the current state.
- Optional `plan({ state, body, effectId })` validates and freezes an execution intent
  without starting an Agent, submitting a task, or changing a workspace.
- `prepare({ state, body, intent, effectId, recordIntent, runEffect })` captures external results.
  Commands declaring `tracksEffects: true` must wrap externally visible mutations in
  `runEffect(operation)`. Other prepare functions are conservatively considered
  effectful before they are called.
- Optional `recover({ state, body, intent, effectId })` queries an existing operation.
  It returns `{ status: 'prepared', prepared: { payload, result } }`,
  `{ status: 'not_started' }`, or `{ status: 'unknown' }`. Only a confirmed
  `not_started` result permits preparation again with the same intent and ID.
- `recordIntent(intent)` freezes additional execution input before the first effect.
- `apply(state, payload)` changes state only and never repeats external effects.

## Persistence and recovery

New records use schema version 2 and `preparing -> prepared -> applied`. Intent is
persisted before effects; the prepared payload and result are persisted before state
application. Failed validation before effects is recorded as `failed`. Every new
attempt has its own effect ID; recovery retains the original ID.

`reconcileCommandJournal()` returns `{ state, replayed, blocked }`. Unknown effects,
unavailable recovery queries, or changed state block recovery instead of duplicating
work. Legacy `applied` records remain replayable. An unresolved record is never skipped
to apply a later record. Runtime state exposes the blocker and pauses advancement.

The journal provides process-crash recovery under one Runtime writer. Recovery queries
must be authoritative. Providers without such a query require inspection when an
effect outcome is unknown. Cross-process coordination and hardware execution
idempotency belong to their respective ports.

## Verification

`npm run test:command-recovery`, `npm run test:journal`, and the release gates.

## Read-only inspection

`inspectCommandJournal(state, { journal, registry })` reports pending recovery as a
transient blocked projection. It never calls `prepare/recover/apply`, acknowledges
entries, or writes the journal. Recoverable pending entries report
`COMMAND_PENDING_RECOVERY`; unknown effects and invalid recovery contexts preserve
their specific error codes. Snapshot GET/SSE use inspection only. Explicit runtime
advancement uses `reconcileCommandJournal` before the application pipeline.
