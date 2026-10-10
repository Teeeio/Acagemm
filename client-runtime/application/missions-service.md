# Missions Service Contract

## Purpose

`missions-service.mjs` owns the basic Mission list and creation use cases. Run execution, research, cancellation, event streaming, and workflow actions remain separate commands until their side-effect ports are extracted.

## Inputs And Outputs

Preparation configurations are separate `state.missionDrafts` records, not
executable Missions. `saveDraft({form,id?,revision?})` accepts managed generic
forms with a nonempty operator/goal and at most 128 KiB of configuration. It
returns `{draft,state}` without workspace, Agent, queue, active-Mission or
active-Project transitions. `getDraft(id)` returns `{draft}`. Updates require
the current integer revision; conflicts return `MISSION_DRAFT_CONFLICT` (409),
missing IDs `MISSION_DRAFT_NOT_FOUND` (404), invalid forms `MISSION_DRAFT_INVALID`
(400). Files are managed by the existing Project import path, not this service.

`create({...,draftId,draftRevision})` verifies the current revision before
domain/workspace work and consumes it in the same state write as the new
Mission. Failed validation/workspace creation leaves the preparation intact.
State is cloned before mutation. Full Mission validation remains required at
the generic-spec client boundary; draft save is never a run/start endpoint.

| Operation | Input | Output |
|---|---|---|
| `list()` | none | `{ missions, activeMissionId }` |
| `create(input)` | Mission fields with a non-empty `goal`, optional `missionBudgetMs` and boolean `missionPaused` | `{ state }` with the new Mission active and its workspace initialized |

## Injected Ports

- `loadState()` and `persistState(state)): coordinated Runtime state access.
- `ensureMissionWorkspace(id, repository, options)`: creates the Mission Snapshot workspace.
- Optional `bindExperiment({state,mission})`: trusted experiment admission/read
  port returning the server-owned experiment binding. Called after domain
  validation and before workspace or persistence. Errors leave stored state and
  preparation drafts untouched. Ordinary deployments omit it. Controlled modes
  and `EXPERIMENT_MEMORY_CONFLICT` (409) are defined in
  [experiment-memory.md](../experiment-memory.md).
- `validateMissionBudgetInput(input)`: shared budget contract.
- `missionState.createMission(state, input)`: required injected domain transition.
  A missing method throws TypeError at construction; no state-store fallback.

## Stable Errors

| Code | HTTP status | Meaning |
|---|---:|---|
| `MISSION_GOAL_REQUIRED` | 400 | Goal is empty or whitespace |
| `INVALID_MISSION_BUDGET` | 400 | Budget is not null/zero or a positive millisecond value |
| `INVALID_MISSION_PAUSED` | 400 | Supplied pause flag is not a boolean |

Domain errors from `createMission` and workspace initialization are preserved.

## Invariants

- Mission creation persists only after its workspace initialization succeeds.
- The service does not parse URLs or write HTTP responses.
- Mission state transitions belong to the injected `mission-project-state.mjs`
  domain factory; this application module does not import the compatibility facade.
- Run execution and research side effects are not started by Mission creation.
- `missionPaused:true` is a saved draft: the domain creates its record and active
  projection paused before the single persistence call. Auto tick cannot observe
  an intermediate unpaused draft. Omitted/false retain legacy behavior. Invalid
  flag types are refused before the domain/workspace/persistence ports; the
  service does not coerce strings such as `"true"` into execution decisions.
- This flag does not mark Baseline complete, start a budget, or call `/runs`.
  Existing resource-release checks still apply to Mission creation/selection.

## Verification

```bash
npm run test:missions-service
npm run test:smoke
npm run verify:local-c500-release
```
