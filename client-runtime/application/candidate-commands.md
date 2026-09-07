# createCandidateCommands

Application command handlers for `apply-patch`, `rollback-stage`.

## Public API

The factory receives injected domain functions and effect ports and returns a command registry fragment. Dependencies: `addAuditEvent`, `agentRuntime`, `appendRuntimeEvent`, `applyCandidatePatch`, `artifactDirForMission`, `createDecisionReviewState`, `createWorkspaceCheckpoint`, `ensureMissionWorkspace`, `isManagedWorkspaceRuntimeMode`, `mkdir`, `path`, `restoreWorkspaceCheckpoint`, `rootDir`, `workspaceManager`, `writeFile`, `now`. The clock is optional.

The fragment implements the [command journal protocol](../command-journal.md). External mutations in prepare pass through runEffect; apply changes only the supplied state. HTTP, persisted Mission state access and queue scheduling remain outside this module. Fixed Profile, evidence binding, Baseline oracle, retry limits and Gate requirements retain their existing semantics.

## Verification

`npm run test:workflow-commands`, `npm run test:command-recovery`, `npm run test:journal`, and the release gates.
