# Workflow Command Policy

Public pure helper `assertGenerationOnlyAction(state, action)` gates application
commands using the persisted Mission mode. It permits the first run and candidate
freeze only; a previous run/candidate rejects another generation with
`GENERATION_ONLY_RUN_UNAVAILABLE` (409). Pending artifacts reject mutations with
`GENERATION_ONLY_PENDING_VALIDATION` (409); testing/resume/other workflow actions
return `GENERATION_ONLY_ACTION_UNAVAILABLE` (409). Messages explicitly state that
later test authorization is not implemented. `guardWorkflowTransition` permits
only candidate.plan/apply-patch in this mode, so the existing manual baseline and
candidate benchmark service cannot bypass the lifecycle. `guardMutation` retains
resource-release precedence, then denies pending mutations before clock changes.
Legacy Missions without a mode retain iterate behavior. No helper clears counters,
extends deadlines or turns a frozen artifact into test evidence.

Manual adoption validates the recognized decision DTO and its exact candidate
ID/digest/benchmark run binding before copying it to current best. It preserves
the original review Gate and stores candidateDigest/evidenceRunId with the best.

Owns Mission mutation budgets, workflow-stage admission, runtime capability guards and adoption state transitions. The factory receives injected domain functions, an Agent capability port and a clock. It returns `guardMutation`, `hasMissionBudgetInput`, `validateMissionBudgetInput`, `guardSupportedRuntimeAction`, `guardWorkflowTransition`, `interventionOutcomeMeta`, `adoptCandidateState`.

It performs no file, HTTP or hardware operations. The Agent descriptor is the sole asynchronous query. Domain state mutations preserve Gate admission, fixed budgets and recovery snapshots.

Adoption derives its evidence fields from the unified decision, never from legacy
booleans: `currentBest.evidenceSource` comes from `decision.execution.source`,
`verified` only from `decision.publication.status === 'allowed'`, and
`liveHardware` from `decision.execution.liveHardware`. The same decision is cloned
into `currentBest.evidenceDecision`; a record with no decision is non-verified and
non-live. A Gate is only used when its candidateId matches the adopted candidate,
and its embedded decision is only copied when `binding.candidateId`/`binding.runId`
match the current candidate/run — a foreign or mismatched decision is dropped
rather than copied from another candidate/run. Human adoption preserves the
original Gate and its conclusion (it never rewrites `passed`/`result`); it only
records the adoption disposition. Human approval through this path does not bypass
Gate admission, resource-release or budget guards.

Verification: npm run test:workflow-commands, npm run test:mission-budget, npm run test:journal and release gates.

Mutation admission first enforces the provider-neutral resource-release barrier.
MISSION_RESOURCE_RELEASE_PENDING (409) forbids new work or workspace changes while
cancelled/orphaned workers have not confirmed termination; it does not discard
Candidate evidence or change any fixed budget.
