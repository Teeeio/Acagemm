# createBenchmarkCommands

Application command handlers for `start-benchmark`.

New semantic task bindings hash the actual independent oracle/performance-baseline
bytes selected after immutable source preparation. They never hash the candidate
as its own reference. A declared frozen reference mismatch fails before queue
submission. Recovery uses the recorded request, including these hashes; older
recorded intents remain unchanged. This content identity grants neither upstream
source authority nor publication eligibility.

An internal `pendingManifestDigest` comes only from the explicit pending-candidate
service/pipeline. The injected `readPendingCandidate` port supplies immutable bytes;
[pending-test-contract](../pending-test-contract.md) supplies admission and inputs.
Request overrides cannot replace the frozen matrix, sources or oracle. Apply stores
`pendingTest` separately from the immutable DTO and keeps generation paused.

## Public API

The factory receives injected domain functions and effect ports and returns a command registry fragment. Dependencies: `addAuditEvent`, `appendRuntimeEvent`, `baselineMatchesMatrix`, `createSemanticTaskBinding`, `hashKey`, `isFixedOperatorMission`, `localC500Config`, `missionShapeKeyFor`, `normalizeBaselineKind`, `operatorTestQueue`, `timeoutSeconds`, `readMissionRunPy`, `resolveBaselineRunPlan`, `now`. The clock is optional.

The fragment implements the [command journal protocol](../command-journal.md). External mutations in prepare pass through runEffect; apply changes only the supplied state. HTTP, persisted Mission state access and queue scheduling remain outside this module. Fixed Profile, evidence binding, Baseline oracle, retry limits and Gate requirements retain their existing semantics.

## Recovery contract

`plan` allocates a stable run ID from the journal effect ID. `prepare` freezes the
complete queue request and state-application payload through `recordIntent` before
submission. The request includes Candidate digest, independent oracle, matrix and
implementation files. Recovery uses `findByRequestId` with the expected frozen request.
For candidate tests, `payload.comparisonBaseline` freezes the selected baseline
run ID, kind and source before submission. Apply/replay preserve this identity even
if current baseline changes. It is reporting provenance, not new queue admission
or Gate policy; legacy commands without it report comparison provenance unknown.
A missing task permits submission of that same request; an existing task reconstructs
the result without re-reading the workspace. Queue lookup errors do not prove absence.
Frozen submissions declare `mission-runtime` journal scope; ordinary Benchmark
commands keep the active-Mission guard. Their idempotency predicate also checks
the exact task/run IDs. An already expired frozen request is recorded by the queue
as terminal without starting the backend; recovery never renews its deadline.

## Verification

`npm run test:workflow-commands`, `npm run test:command-recovery`, `npm run test:journal`, and the release gates.

Mission/operator Profile identity is preserved in both Baseline and Candidate
requests. Baseline also receives an explicit frozen oracleRunPy copy; Candidate
continues to use the stored Baseline oracle. CPU diagnostics default disabled and
liveHardware uses the actual backend capability (CPU cannot become live evidence).

## Automatic immutable source preparation

Optional port `freezeCandidateSource({state,mission,candidate})` prepares a content-addressed source bundle. Ordinary candidate tests require confirmed Agent/resource release, freeze the original candidate and use the same immutable test inputs as explicit pending submissions. The request and application payload retain `automaticFrozenCandidate`; recovery never reads the current workspace. This non-executable immutable preparation (like execution-package preparation) precedes `recordIntent`; only queue submission enters `runEffect` after the complete intent has been recorded. Starting an effect earlier makes the journal intent immutable and prevents durable request preparation.
