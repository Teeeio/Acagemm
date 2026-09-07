# Codex CLI Client Contract

Adapter for the locally configured Codex CLI. It owns CLI probes, process startup,
JSONL event capture, atomic per-run records and bounded process-tree cancellation.
It does not own Mission persistence, candidate adoption, Gate or hardware tests.

## Public API

`createCodexClient(options)` returns describe, preflight, start, readRun,
readEvents, cancel, eventText and configuration metadata. Existing start inputs
and provider CLI arguments remain compatible. Records now use schemaVersion 2
and preserve runId, missionId, workspace, threadId and event path, adding
`process.{pid,ownerPid,instanceId,exitedAt,exitCode,signal}` and resourceRelease.

- start creates a process in the requested isolated workspace. On Unix it creates
  a dedicated process group; Windows processes remain hidden.
- readRun/readEvents inspect records only. They never start, kill, repair or
  rewrite a run. An active record without this adapter's live owner is projected
  as cancel_requested / CODEX_EXECUTION_OWNER_UNAVAILABLE. It is unsafe to signal
  a persisted PID that may have been reused; such recovery requires inspection.
- turn.completed records logical completion, not process release. Only child
  close and any required cancellation cleanup publish completed/cancelled/failed.
- cancel(runId) persists intent before termination. Windows uses bounded taskkill
  /T, escalating to /F; Unix sends SIGTERM then SIGKILL to the process group.
  Confirmed cancellation requires child close and process-tree cleanup evidence.
  Failure to confirm before the deadline returns cancel_requested with explicit
  unconfirmed reason/nextAction and keeps the workspace blocked.
- Late events cannot overwrite an already confirmed process exit with a running
  snapshot. Writes are serialized and atomically renamed.

Cancellation grace/force waits default to 1 second each; CLI termination requests
also have a force-wait timeout. logicalCleanupMs defaults to 1.5 seconds after a
turn.completed event. Options cancelGraceMs, cancelForceMs, logicalCleanupMs and
terminateProcessTree support bounded contract testing. Injected termination
returning success still requires an actual close event; a timeout is never proof.

No Provider credentials are persisted or logged; errors use the existing redaction.
The test-owned Node process tree is only a cancellation test, not a Codex/model run.

Tests:
`node tests/codex-runtime-test.mjs`
`node tests/codex-cancellation-test.mjs`.

