# createDecisionCommands

`resume-mission` checks resource release and `assertGenerationOnlyAction(state,
'resume')` in `plan` before the command intent is appended. `prepare` and `apply`
repeat admission so direct preparation or an old prepared journal entry cannot
renew budgets/unpause a generate-only Mission or its pending candidate. Such
requests return the documented generation-only 409; ordinary resume semantics
remain unchanged.

Application command handlers for `resume-mission`, `adopt`, `reject`, `request-review`, `cancel-review`, `revert-adoption`, `resolve-review`.

## Public API

The factory receives injected domain functions and effect ports and returns a command registry fragment. Dependencies: `addAuditEvent`, `adoptCandidateState`, `appendRuntimeEvent`, `createDecisionReviewState`, `hasMissionBudgetInput`, `interventionOutcomeMeta`, `normalizeMissionBudgetMs`, `restoreWorkspaceCheckpoint`, `runAutomaticAdoption`, `validateMissionBudgetInput`, `workspaceManager`, `now`. The clock is optional.

The fragment implements the [command journal protocol](../command-journal.md). External mutations in prepare pass through runEffect; apply changes only the supplied state. HTTP, persisted Mission state access and queue scheduling remain outside this module. Fixed Profile, evidence binding, Baseline oracle, retry limits and Gate requirements retain their existing semantics.

## Verification

`npm run test:workflow-commands`, `npm run test:command-recovery`, `npm run test:journal`, and the release gates.
