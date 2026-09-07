# Workflow Command Policy

Owns Mission mutation budgets, workflow-stage admission, runtime capability guards and adoption state transitions. The factory receives injected domain functions, an Agent capability port and a clock. It returns `guardMutation`, `hasMissionBudgetInput`, `validateMissionBudgetInput`, `guardSupportedRuntimeAction`, `guardWorkflowTransition`, `interventionOutcomeMeta`, `adoptCandidateState`.

It performs no file, HTTP or hardware operations. The Agent descriptor is the sole asynchronous query. Domain state mutations preserve Gate admission, fixed budgets and recovery snapshots.

Verification: npm run test:workflow-commands, npm run test:mission-budget, npm run test:journal and release gates.

Mutation admission first enforces the provider-neutral resource-release barrier.
MISSION_RESOURCE_RELEASE_PENDING (409) forbids new work or workspace changes while
cancelled/orphaned workers have not confirmed termination; it does not discard
Candidate evidence or change any fixed budget.
