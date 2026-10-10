# createCandidateCommands

## Generate-only freeze port

Optional constructor port `freezePendingCandidate({state,mission,candidate,workspace,diff})`
is required when applying a generate-only candidate. `workspace` is the real
absolute managed workspace path and `diff` the complete `captureDiff` result.
The port owns immutable byte storage; it must return a durable DTO:

```text
{ schemaVersion:'operator-studio.pending-candidate/v1', status:'awaiting_backend',
  missionId, candidateId, sourceRunId, roundId, patchDigest, manifestDigest,
  artifactPath, createdAt, files:[{path,digest,size}],
  baselineDigest, semanticDigest, testSpecDigest }
```

Admission requires the original release barrier to clear, the generating Agent
to be completed/awaiting_action with explicit confirmed release, no other active
Mission resources, and the captured diff to match the admitted candidate/run.
Missing port returns `PENDING_CANDIDATE_FREEZER_UNAVAILABLE` before effects;
identity/digest/DTO failures return `PENDING_CANDIDATE_BINDING_INVALID` (409).
The freezer runs inside `runEffect`, with its DTO copied into the prepared
journal payload. A failed effect remains subject to normal journal recovery,
not automatic rollback or repeated freezing.

`apply` copies the DTO into `iterationStats.pendingValidation`, pauses the Mission,
sets loop `blocked/awaiting_backend`, and marks only the Agent generation as
`completed` with no next action. The Mission remains blocked and untested.
`isApplied` requires the persisted pending DTO and pause, not merely an applied
patch. A prepared replay uses the saved DTO without calling the freezer.
Candidate sourceRunId comes from the frozen payload (legacy payloads may use
their saved candidate identity), never the current Agent during replay.
No baseline, Gate, test result, current best or budget is synthesized.

Ordinary test-plan labels use the Mission/testMatrix environments and correctness
case count. This module does not own reconnecting a backend or admitting a later
test of the stored candidate.

Application command handlers for `apply-patch`, `rollback-stage`.

## Public API

The factory receives injected domain functions and effect ports and returns a command registry fragment. Dependencies: `addAuditEvent`, `agentRuntime`, `appendRuntimeEvent`, `applyCandidatePatch`, `artifactDirForMission`, `createDecisionReviewState`, `createWorkspaceCheckpoint`, `ensureMissionWorkspace`, `isManagedWorkspaceRuntimeMode`, `mkdir`, `path`, `restoreWorkspaceCheckpoint`, `rootDir`, `workspaceManager`, `writeFile`, `now`. The clock is optional.

The fragment implements the [command journal protocol](../command-journal.md). External mutations in prepare pass through runEffect; apply changes only the supplied state. HTTP, persisted Mission state access and queue scheduling remain outside this module. Fixed Profile, evidence binding, Baseline oracle, retry limits and Gate requirements retain their existing semantics.

`PatchPolicyCheckError` is the exported admission error type, emitted only before
`runEffect`. Its HTTP fields remain `status=409`, `code=PATCH_POLICY_CHECK_FAILED`
and `details=policyChecks`. Automatic candidate orchestration consumes this type;
an arbitrary error carrying the same string code is not an effect-free outcome.

## Verification

`npm run test:workflow-commands`, `npm run test:command-recovery`, `npm run test:journal`, and the release gates.
