# Command Journal Contract

The command journal coordinates durable intent, external effects, deterministic state
application, and recovery. Callers hold the State Repository exclusive lock and pass
a fresh state snapshot. It does not select providers, execute hardware, or decide Gate
outcomes.

## Command protocol

- `keyFor(state, body)` identifies a logical command; `isApplied(state, payload)` checks
  whether a completed command still describes the current state.
- Optional `scopeFor(body)` returns `mission-runtime` for commands that explicitly
  permit recovery in their owning Mission; the default is `active-mission`.
  This scope is persisted with the intent and checked against the registered
  handler again during recovery. Missing/legacy scope retains the active-Mission
  guard. A scope is not permission to ignore snapshot-version changes.
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
- Optional `validateApply({state,payload})` performs read-only prerequisite checks
  immediately before apply, including replay. It must not mutate state, spawn,
  submit or write files. Failure prevents application. Frozen feedback uses it to
  reject workspace edits made after preparation or before process recovery.

## Persistence and recovery

`createCommandJournal({ filePath, renameFile? })` uses atomic file replacement.
The optional `renameFile(from, to)` port defaults to filesystem rename and must
preserve its atomic semantics. Windows `EPERM`, `EBUSY`, and `EACCES` replacement
conflicts retry the same fsynced temporary file at most 12 times with 25–275 ms
backoff (1,650 ms total). Other errors fail immediately. The previous journal
is never removed to permit replacement, and no command effect is retried by this
storage policy. Exhaustion retains the old durable recovery intent and throws;
an unconfirmed external effect still requires authoritative recovery.

New records use schema version 2 and `preparing -> prepared -> applied`. Intent is
persisted before effects; the prepared payload and result are persisted before state
application. Failed validation before effects is recorded as `failed`. Every new
attempt has its own effect ID; recovery retains the original ID.

Explicit execution also acknowledges a `prepared` record already covered by the
committed state cursor before deciding idempotency or a new attempt. This matches
reconciliation: a lost final journal acknowledgement cannot cause state-version
recovery failure or replay a known commit. A prepared record beyond the cursor
still requires normal recovery. Known pre-effect read failures may be prepared
diagnostic payloads; they commit without creating an Agent run.

`reconcileCommandJournal()` returns `{ state, replayed, blocked }`. Unknown effects,
unavailable recovery queries, or changed state block recovery instead of duplicating
work. Legacy `applied` records remain replayable. An unresolved record is never skipped
to apply a later record. Runtime state exposes the blocker and pauses advancement.

Inspection and reconciliation accept an optional `missionState` port with
`createMissionRuntimeView` and `mergeMissionRuntimeView`. Explicitly scoped
background commands recover/apply against their owner and merge only that Mission,
the journal cursor/version and trace outbox. Visible selection and runtime slots
are preserved. Missing owner/ports, mismatched scope or changed global state version
fail closed. Error details always retain command and Mission identity.

Within one Runtime process, the journal keeps a non-persistent active-sequence marker
while `prepare`/`apply` is in flight. Read-only inspection ignores those live entries;
after a process restart the marker is absent and conservative recovery rules apply.

The journal provides process-crash recovery under one Runtime writer. Recovery queries
must be authoritative. Providers without such a query require inspection when an
effect outcome is unknown. Cross-process coordination and hardware execution
idempotency belong to their respective ports.

## Verification

`npm run test:command-recovery`, `npm run test:journal`, and the release gates.

## Read-only inspection

`inspectCommandJournal(state, { journal, registry, missionState? })` reports pending recovery as a
transient blocked projection. It never calls `prepare/recover/apply`, acknowledges
entries, or writes the journal. Recoverable pending entries report
`COMMAND_PENDING_RECOVERY`; unknown effects and invalid recovery contexts preserve
their specific error codes. Snapshot GET/SSE use inspection only. Explicit runtime
advancement uses `reconcileCommandJournal` before the application pipeline.
