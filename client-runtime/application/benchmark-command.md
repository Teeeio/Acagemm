# createBenchmarkCommands

Application command handlers for `start-benchmark`.

## Public API

The factory receives injected domain functions and effect ports and returns a command registry fragment. Dependencies: `addAuditEvent`, `appendRuntimeEvent`, `baselineMatchesMatrix`, `createSemanticTaskBinding`, `hashKey`, `isFixedOperatorMission`, `localC500Config`, `missionShapeKeyFor`, `normalizeBaselineKind`, `operatorTestQueue`, `timeoutSeconds`, `readMissionRunPy`, `resolveBaselineRunPlan`, `now`. The clock is optional.

The fragment implements the [command journal protocol](../command-journal.md). External mutations in prepare pass through runEffect; apply changes only the supplied state. HTTP, persisted Mission state access and queue scheduling remain outside this module. Fixed Profile, evidence binding, Baseline oracle, retry limits and Gate requirements retain their existing semantics.

## Recovery contract

`plan` allocates a stable run ID from the journal effect ID. `prepare` freezes the
complete queue request and state-application payload through `recordIntent` before
submission. The request includes Candidate digest, independent oracle, matrix and
implementation files. Recovery uses `findByRequestId` with the expected frozen request.
A missing task permits submission of that same request; an existing task reconstructs
the result without re-reading the workspace. Queue lookup errors do not prove absence.

## Verification

`npm run test:workflow-commands`, `npm run test:command-recovery`, `npm run test:journal`, and the release gates.

Mission/operator Profile identity is preserved in both Baseline and Candidate
requests. Baseline also receives an explicit frozen oracleRunPy copy; Candidate
continues to use the stored Baseline oracle. CPU diagnostics default disabled and
liveHardware uses the actual backend capability (CPU cannot become live evidence).
