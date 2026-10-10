# Iteration Trace Contract

Agent-run facts distinguish actual execution from workflow readiness:
`timedOut=true` records `status=timed_out`; otherwise `executionStatus` is preferred
over the legacy workflow status. `workflowStatus` stays available separately.
Actual generation completion time, resource release, primary failure and bounded
provider retry diagnostics survive projection. Candidate salvage does not rewrite
a timeout as successful generation. Old evidence is not rewritten automatically.

Mission records retain nullable `attemptOrigin`; parent/child creation events and
the next generation's frozen origin preserve explicit-attempt provenance. This
link does not copy the parent's performance evidence into the child.

Closing a round queues its detailed Agent, candidate, test and decision slots
before reset, even if the next generation starts within the same commit. Test
projection captures the final canonical Gate decision; successful Baseline receipts
are preserved before the display slot is cleared. Terminal replay does not append
again. These are original observations, not newly issued evidence or verdicts.

## Responsibility

`iteration-trace.mjs` projects observed Mission, Agent run, candidate, test,
decision and archived-round facts. It also owns the in-memory `tracePending`
outbox used before the event/audit/round display windows are truncated. It has no
storage, execution, scoring or Gate effects. `TRACE_SCHEMA`, `TRACE_KINDS`,
`traceRecord`, `enqueueTraceRecord` and `projectTraceRecords` are public.

`iteration-trace-store.mjs` is the filesystem adapter. The state-store facade
composes it with raw snapshot storage; application code receives its read port.
It stores JSON batches under `dataDir/iteration-traces/<sha256>.json` and an
optional `state.iterationTrace` index. Older snapshots remain readable without
initializing traces. An ordinary future save starts recording available facts.

## Identity and coverage

Every record has `key`, `kind`, `id`, `missionId`, `projectId`, `experimentId`,
and `data`. Keys include Mission and kind. Candidates additionally distinguish
source run and patch digest, so reused candidate labels cannot merge different
implementations. Archived rounds use generation run ID; test records use queue
request/run ID. Revision metadata carries state version and observation time.

The trace preserves existing declared fields, prompt audit references,
candidate reasoning, code/test identities, results, decision reasons, usage and
timestamps. Missing experiment/parent identities or stage timestamps stay null
or absent; they are not reconstructed from a later current best. New Mission
creation, manual/automatic start and queue projection now provide experiment
identity, frozen generation origin and stage timings through
[generation-origin.md](generation-origin.md). Batch manifest admission remains
H16 work. An observation timestamp is not a stage duration.
Prompt audit is not proof of provider receipt or of experience benefit. Stored
results retain their original evidence/publication qualification; trace storage
does not certify a result or turn observations into graded evidence.

`runtimeEvents` (500), `auditEvents` (30), and `runHistory` (20) remain bounded UI
projections. New event/audit additions and round archives enter `tracePending`
before trimming, including multiple transitions between commits and switching
Missions. UUID event IDs are opaque; event sequence remains the SSE cursor.
Historical audit entries without IDs are not assigned invented event identities.
Test projection also enqueues a complete observation before Baseline settlement
clears the Benchmark display slot, including its execution-package bindings.

Coverage reports `startedAt` and `priorHistory=available-snapshot-only`. Earlier
history already discarded by older versions cannot be recovered. No-recording
snapshots return `status=not_started`, not an invented empty successful history.
Facts not committed to a runtime snapshot before a crash are not claimed durable.

## Atomicity, faults and growth

`createIterationTraceStore({directory, filesystem?})` exposes:

- `prepare(state)`: writes a content-addressed immutable batch before returning a
  new state with its head reference. It strips the pending outbox only from that
  returned state. It does not overwrite the supplied state or commit a snapshot.
- `query(traceIndex, {missionId,kind?,view?,limit?,cursor?})`: reads committed facts
  only. Missing/corrupt batches or hashes fail visibly with `TRACE_CORRUPT` (503).

`createTraceStateWriter({traceStore,writeSnapshot})` composes preparation followed
by the existing atomic snapshot replacement. Only a batch reachable from the
committed snapshot head is visible. A snapshot-write failure can leave a prepared
orphan; querying the old snapshot cannot see it, even with a forged cursor. A
retry may reuse a byte-verified prepared file. No garbage collection or repair is
performed on GET. Copying/moving a snapshot must include its trace directory.

Trace write failure returns `TRACE_WRITE_FAILED` (503) and prevents the snapshot
write. Snapshot errors retain their existing contract. Readers check hashes and
chain ordering; save checks the previous head. This is process-crash atomicity
under State Repository serialization, not cross-process locking or an fsync /
power-loss durability guarantee. Orphans/temporary files are retained for diagnosis.

An index of only currently observed records avoids copying a full lifetime index
into every state. Unchanged records do not append batches; updates keep revisions.
Queries walk the chain and deduplicate by key. This initial implementation favors
correctness for local runs; it does not promise constant-time lifetime queries.

## Query API

The application factory `createIterationTraceService({readState,traceStore})`
provides `query(missionId, options)`. It verifies Mission existence (404
`MISSION_NOT_FOUND`) and uses only read ports. It never selects a Mission,
initializes storage, repairs files, advances a workflow or dispatches hardware.

`GET /api/missions/:id/traces?kind=round&limit=100` returns
`{missionId,records,nextCursor,coverage}`. The default `view=latest` returns one
record per identity; `view=revisions` returns historical revisions explicitly.
Neither view computes scores. `limit` is 1–200. Cursors are opaque, pinned to a
committed ancestor and bound to Mission/kind/view; subsequent saves do not change
an in-progress pagination. Invalid input returns `TRACE_QUERY_INVALID` (400).

## Verification

`test:iteration-trace` exercises real snapshot commits and re-opened storage,
window overflow within a single commit, multi-Mission scope, revisions, pinned
pagination, storage failure, snapshot failure/orphans, retry and corruption.
`test:runtime-read-isolation` exercises the production HTTP endpoint with no
execution or storage side effects. Both run in the full release gate. These are
software tests; they do not establish live model/GPU acceptance.
