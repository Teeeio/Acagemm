# Missions Service Contract

## Purpose

`missions-service.mjs` owns the basic Mission list and creation use cases. Run execution, research, cancellation, event streaming, and workflow actions remain separate commands until their side-effect ports are extracted.

## Inputs And Outputs

| Operation | Input | Output |
|---|---|---|
| `list()` | none | `{ missions, activeMissionId }` |
| `create(input)` | Mission fields with a non-empty `goal`, optional `missionBudgetMs` | `{ state }` with the new Mission active and its workspace initialized |

## Injected Ports

- `loadState()` and `persistState(state)): coordinated Runtime state access.
- `ensureMissionWorkspace(id, repository, options)`: creates the Mission Snapshot workspace.
- `validateMissionBudgetInput(input)`: shared budget contract.
- `missionState.createMission(state, input)`: required injected domain transition.
  A missing method throws TypeError at construction; no state-store fallback.

## Stable Errors

| Code | HTTP status | Meaning |
|---|---:|---|
| `MISSION_GOAL_REQUIRED` | 400 | Goal is empty or whitespace |
| `INVALID_MISSION_BUDGET` | 400 | Budget is not null/zero or a positive millisecond value |

Domain errors from `createMission` and workspace initialization are preserved.

## Invariants

- Mission creation persists only after its workspace initialization succeeds.
- The service does not parse URLs or write HTTP responses.
- Mission state transitions belong to the injected `mission-project-state.mjs`
  domain factory; this application module does not import the compatibility facade.
- Run execution and research side effects are not started by Mission creation.

## Verification

```bash
npm run test:missions-service
npm run test:smoke
npm run verify:local-c500-release
```
