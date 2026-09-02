# Mission Control Service Contract

Coordinates explicit Agent-run cancellation, human feedback injection, and stopping the active Mission.

| Method | Input | Output | Stable errors |
|---|---|---|---|
| `cancelRun(missionId, runId)` | decoded IDs | persisted state and runtime result | `AGENT_MISSION_MISMATCH` |
| `addHumanFeedback(body)` | `note` with at least two trimmed characters | persisted running state and feedback DTO | `HUMAN_FEEDBACK_REQUIRED` |
| `stopMission()` | none | persisted stopped state | `MISSION_NOT_FOUND` |

Stopping coordinates cancellation of an active Operator Test and Agent run, but cancellation failures do not prevent the local Mission from reaching its explicit stopped state. The service emits canonical runtime/audit events through injected ports. It does not implement Agent-provider cancellation, queue locking, TUI behavior, or hardware rules.

```bash
npm run test:mission-control-service
npm run test:smoke
npm run test:module-boundary
```
