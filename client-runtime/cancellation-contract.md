# Cancellation Contract

Pure provider-neutral cancellation truth shared by application commands and Agent
projection. No filesystem, clock, process, provider or persistence effects.

- `isExecutionReleased(snapshot)`: true only for completed/failed/cancelled and
  no explicit `resourceRelease.confirmed=false`. Legacy adapters/fixtures without
  the new field retain their terminal-status contract. New adapters must provide
  explicit release evidence.
- `pendingMissionResources(state)`: active main Agent, Research, Baseline
  Materializer and Operator Test as `{ kind, id, snapshot }`.
- `reconcileResourceRelease(state)`: updates a loaded snapshot’s release summary
  from matching kind/id records and returns `{ state, changed }`; no I/O.
- `resourceReleaseBarrier(state)`: the unresolved Mission release summary or
  unresolved per-resource cancellation projection; otherwise null. It projects
  matching confirmed resource records without mutating its input, so a stale
  summary cannot permanently block a confirmed exit. Missing/different run IDs
  never count as proof of release. Normal
  `status=active` executions are not cancellation barriers.
- `assertResourcesReleased(state)`: throws `MISSION_RESOURCE_RELEASE_PENDING`
  (409) when a barrier remains. Used before resume, new dispatch, or workspace
  mutation; it does not initiate cancellation.

A release summary includes confirmed, status, reason, deadline, nextAction,
`blocked`/`quarantined` markers and per-resource kind/id. After the bounded
cancellation attempts are exhausted, the workflow may expose
`needs_human` plus these markers; this is a finite business outcome, not proof
that the process has exited. The barrier remains active until owner-aware
release evidence is supplied. `primaryFailure` describes the upstream cause
when known and must not be overwritten by a release error. pending/unconfirmed
is never a terminal execution result.
Explicit confirmed=false wins over a conflicting textual status.

Tests: `node tests/agent-cancellation-liveness-test.mjs`.
