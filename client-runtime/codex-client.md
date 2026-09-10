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
- Model selection is explicit and never persisted: `createCodexClient({ model })`
  wins over `OPERATOR_CODEX_MODEL`, which wins over legacy `CODEX_MODEL`. The
  shared-GPU acceptance harness defaults to `gpt-5.6-sol`; set
  `OPERATOR_CODEX_MODEL=gpt-5.5` when that lower-cost model is preferred.
- readRun/readEvents inspect records only. They never start, kill, repair or
  rewrite a run. An active record without this adapter's live owner is projected
  as cancel_requested / CODEX_EXECUTION_OWNER_UNAVAILABLE. It is unsafe to signal
  a persisted PID that may have been reused; such recovery requires inspection.
- turn.completed records logical completion, not process release. Only child
  close and any required cancellation cleanup publish completed/cancelled/failed.
- `classifyCodexFailure` keeps upstream causes explicit: provider capacity is a
  bounded retryable condition (`CODEX_PROVIDER_CAPACITY`), while certificate
  trust failures are non-retryable under the same configuration
  (`CODEX_TLS_TRUST_FAILED`). The Agent Runtime stores this as
  `primaryFailure`; it never replaces the separate resource-release status.
- cancel(runId) persists intent before termination. Windows uses bounded taskkill
  /T, escalating to /F; if taskkill is denied, the live ChildProcess handle may
  receive a best-effort parent stop, but this never counts as tree termination.
  Unix sends SIGTERM then SIGKILL to the process group. Confirmed cancellation
  requires child close and process-tree cleanup evidence; an unverified Windows
  descendant remains quarantined as `CODEX_PROCESS_TREE_UNVERIFIED`.
  Failure to confirm before the deadline returns cancel_requested with explicit
  unconfirmed reason/nextAction and keeps the workspace blocked.
- Late events cannot overwrite an already confirmed process exit with a running
  snapshot. Writes are serialized and atomically renamed.

Cancellation grace/force waits default to 2 and 5 seconds; CLI termination requests
also have a force-wait timeout. logicalCleanupMs defaults to 15 seconds after a
turn.completed event so short-lived Windows PowerShell/tool descendants can drain
before cancellation is classified as unconfirmed. Options cancelGraceMs, cancelForceMs, logicalCleanupMs and
terminateProcessTree support bounded contract testing. Injected termination
returning success still requires an actual close event; a timeout is never proof.

No Provider credentials are persisted or logged; errors use the existing redaction.
The test-owned Node process tree is only a cancellation test, not a Codex/model run.

Tests:
`node tests/codex-runtime-test.mjs`
`node tests/codex-cancellation-test.mjs`.
