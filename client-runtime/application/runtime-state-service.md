# Runtime State Service Contract

Owns the TUI state command used to update test matrix, workspace display state, unread count, Mission budget, and pause/resume lifecycle.

`patch(body)` returns a transport-neutral status/payload result. Supported writable fields are `testMatrix`, `workspace`, `unreadCount`, `missionPaused`, and the compatible budget forms `missionBudgetMs`, `timeBudgetMs`, `missionBudgetHours`, `timeBudgetHours`. Invalid matrices return HTTP 400; invalid budgets return `INVALID_MISSION_BUDGET` (400).

The service preserves the canonical `resumeMissionState` transition and clears `missionBudgetStartedAt` when a budget is disabled. It does not parse URLs, render HTTP, execute workflow actions, or define state normalization; persistence, state transitions, and budget normalization are injected.

```bash
npm run test:runtime-state-service
npm run test:module-boundary
npm run test:smoke
```
