# Runtime State Service Contract

Owns the TUI state command used to update test matrix, workspace display state, unread count, Mission budget, and pause/resume lifecycle.

`patch(body)` returns a transport-neutral status/payload result. Supported writable fields are `testMatrix`, `workspace`, `unreadCount`, `missionPaused`, and the compatible budget forms `missionBudgetMs`, `timeBudgetMs`, `missionBudgetHours`, `timeBudgetHours`. Invalid matrices return HTTP 400; invalid budgets return `INVALID_MISSION_BUDGET` (400).

The service preserves the canonical `resumeMissionState` transition and clears `missionBudgetStartedAt` when a budget is disabled. It does not parse URLs, render HTTP, execute workflow actions, or define state normalization; persistence, state transitions, and budget normalization are injected.

```bash
npm run test:runtime-state-service
npm run test:module-boundary
npm run test:smoke
```

Resuming via missionPaused=false also requires confirmed resource release; unknown
workers produce MISSION_RESOURCE_RELEASE_PENDING before persistence. Pausing and
read-only inspection remain available.

Once a `generate-only` Mission starts (or has a pending frozen candidate), patching
the test matrix, workspace or budget, or unpausing it, returns
`GENERATION_ONLY_CONTRACT_FROZEN` before persistence. Waiting does not renew the
original deadline. Read markers and pausing remain available.
