# createAgentCommands

Application command handlers for `runs`, `research`, `materialize-baseline`.

## Public API

The factory receives injected domain functions and effect ports and returns a command registry fragment. Dependencies: `addAuditEvent`, `agentRuntime`, `appendRuntimeEvent`, `artifactDirForMission`, `baselineDirForMission`, `buildRuntimePreflight`, `createWorkspaceCheckpoint`, `hashKey`, `isManagedWorkspaceRuntimeMode`, `isStrictZeroSourceMission`, `mkdir`, `path`, `researchDirForMission`, `resetMissionRunState`, `resetMissionWorkspace`, `selectResearchBaselineSource`, `selectResearchDirection`, `startAgentRun`, `now`. The clock is optional. Production also supplies roundExperience.prepare.
The initial runs plan freezes a complete-round deadline. Prepare retrieves the
frozen round experience before checkpoint/Agent effects and records both in the
journal intent. Prepared payload/apply retain these values; neither recovery nor
same-round retries can refresh the deadline or silently select newer experience
versions. Budget is rechecked before launching the Agent.

Only explicit runs.plan may allocate a new monotonic budget identity after a
persisted completed budget and published/completed knowledge maintenance. This
manual new run does not require or modify legacy evidence/performance/retry
counters, and does not renew the total Mission budget. Active/expired rounds,
repair and pause/resume never gain time through this permission. Prepare/replay
has no new-round permission: it validates the raw frozen intent even while the
containing state still describes the previous published round. The new identity
selects new round experience; retries and replay keep that identity's context.

The fragment implements the [command journal protocol](../command-journal.md). External mutations in prepare pass through runEffect; apply changes only the supplied state. HTTP, persisted Mission state access and queue scheduling remain outside this module. Fixed Profile, evidence binding, Baseline oracle, retry limits and Gate requirements retain their existing semantics.

## Verification

`npm run test:workflow-commands`, `npm run test:command-recovery`, `npm run test:journal`, and the release gates.
