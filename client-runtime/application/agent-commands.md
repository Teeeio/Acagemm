# createAgentCommands

Application command handlers for `runs`, `research`, `materialize-baseline`.

## Public API

The factory receives injected domain functions and effect ports and returns a command registry fragment. Dependencies: `addAuditEvent`, `agentRuntime`, `appendRuntimeEvent`, `artifactDirForMission`, `baselineDirForMission`, `buildRuntimePreflight`, `createWorkspaceCheckpoint`, `hashKey`, `isManagedWorkspaceRuntimeMode`, `isStrictZeroSourceMission`, `mkdir`, `path`, `researchDirForMission`, `resetMissionRunState`, `resetMissionWorkspace`, `selectResearchBaselineSource`, `selectResearchDirection`, `startAgentRun`, `now`. The clock is optional. Production also supplies roundExperience.prepare.
The initial runs plan freezes a complete-round deadline. Prepare retrieves the
frozen round experience before checkpoint/Agent effects and records both in the
journal intent. Prepared payload/apply retain these values; neither recovery nor
same-round retries can refresh the deadline or silently select newer experience
versions. Budget is rechecked before launching the Agent.
The same freeze applies to the archived-round facts snapshot
(`iterationStats.roundFacts`, see
[mission-project-state](../mission-project-state.md)): the first prepare captures
it after reset, records it in the journal intent, and returns it in the payload;
payload/apply and intent replay reuse the frozen snapshot instead of re-reading
facts that may already describe a newer round. A replay therefore receives the
same previous run/candidate/correctness/Gate/rollback/current-best facts even
while the containing state has advanced.
The per-round selection-audit sidecar
(`iterationStats.roundExperienceSelection`, see
[round-experience-service](round-experience-service.md)) is frozen with the same
discipline. The intent's field is deep-copied onto the clone before prepare, and
immediately after `roundExperience.prepare` the value is frozen again into one
local variable and written back to the clone, so a real prepare cannot leave a
context-derived selection paired with replay-frozen content. Journal intent,
prepared payload and the value seen by the Agent Provider are all deep copies of
that single frozen variable; an explicit `null` is preserved as `null` instead of
being refreshed. `apply` restores the payload value after reset, `null` included;
a missing field means an older intent/payload and keeps the compatibility
fallback to the current prepare product. Frozen contexts, budgets and facts keep
their existing guarantees.

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
